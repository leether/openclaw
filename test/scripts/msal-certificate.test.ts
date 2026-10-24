import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants, sign, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRuntimeCertificate } from "../../scripts/fork-linux/msal/certificate.mjs";
import { runBounded } from "../../scripts/fork-linux/msal/processes.mjs";
import { createFakeEndpoint, client, tenant } from "../../scripts/fork-linux/msal/transport.mjs";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
let generated: ReturnType<typeof createRuntimeCertificate>;
const freshDeadline = () => process.hrtime.bigint() + 30000000000n;
beforeAll(() => {
  generated = createRuntimeCertificate(freshDeadline());
});
afterEach(() => {
  vi.mocked(spawnSync).mockClear();
  vi.restoreAllMocks();
});

describe("ephemeral certificate test material", () => {
  it("uses one bounded fixed OpenSSL process, only stdin, and a verified RSA-2048 pair", () => {
    const [file, args, options] = vi.mocked(spawnSync).mock.calls[0] ?? [];
    expect(file).toBe("/usr/bin/openssl");
    expect(args).toEqual([
      "req",
      "-new",
      "-x509",
      "-key",
      "/dev/stdin",
      "-subj",
      "/CN=msal-qualification.invalid",
      "-days",
      "1",
      "-sha256",
      "-config",
      fileURLToPath(new URL("../../scripts/fork-linux/msal/certificate.cnf", import.meta.url)),
    ]);
    expect(options).toMatchObject({
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 8192,
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.ok(options && typeof options.input === "string");
    expect(options.input === generated.privateKey).toBe(true);
    expect(
      new X509Certificate(generated.certificate).publicKey.asymmetricKeyDetails?.modulusLength,
    ).toBe(2048);
    expect(generated.proof).toMatchObject({
      generatedAtRuntime: true,
      privateKeyPersisted: false,
      keyBits: 2048,
      pairVerified: true,
      openssl: { closed: true, exitCode: 0, signal: null },
    });
    expect(generated.proof.openssl.elapsedMs).toBeLessThanOrEqual(5000);
  });
  it("does not launch OpenSSL when key generation consumed its reserved time", () => {
    vi.spyOn(process.hrtime, "bigint").mockReturnValueOnce(0n).mockReturnValue(20000000000n);
    expect(() => createRuntimeCertificate(30000000000n)).toThrow("leave time");
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it("refuses an already consumed parent budget before generating a key", () => {
    vi.spyOn(process.hrtime, "bigint").mockReturnValue(24000000000n);
    expect(() => createRuntimeCertificate(30000000000n)).toThrow(
      "parent deadline before certificate key generation",
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it("subtracts 11 seconds of startup and 18 seconds of key generation before OpenSSL", () => {
    vi.spyOn(process.hrtime, "bigint")
      .mockReturnValueOnce(11000000000n)
      .mockReturnValue(29000000000n);
    expect(() => createRuntimeCertificate(30000000000n)).toThrow("parent deadline before OpenSSL");
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it("passes the parent's original monotonic deadline through real process startup", async () => {
    const before = process.hrtime.bigint();
    const result = await runBounded(
      [
        "-e",
        "const deadline=process.env.OPENCLAW_MSAL_SCENARIO_DEADLINE_NS; const now=process.hrtime.bigint(); console.log(JSON.stringify({deadline,now:now.toString(),remainingMs:Number((BigInt(deadline)-now)/1000000n)}))",
      ],
      process.cwd(),
    );
    expect(result.passed).toBe(true);
    expect(result.closed).toBe(true);
    assert.ok(result.proof);
    expect(BigInt(result.proof.deadline)).toBeGreaterThanOrEqual(before + 30000000000n);
    expect(BigInt(result.proof.deadline)).toBeLessThanOrEqual(
      process.hrtime.bigint() + 30000000000n,
    );
    expect(result.proof.remainingMs).toBeGreaterThan(0);
    expect(result.proof.remainingMs).toBeLessThan(30000);
  });
  it.each(["RS256", "PS256"])(
    "still verifies actual %s assertions with the ephemeral certificate",
    async (algorithm) => {
      const scope = "https://qualification.invalid/azure-certificate/cache/.default";
      const endpoint = createFakeEndpoint({
        scenario: "azure-certificate",
        certificate: generated.certificate,
      });
      endpoint.expectScope(scope);
      const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const input = `${encode({ alg: algorithm })}.${encode({ iss: client, sub: client, aud: url, exp: Math.floor(Date.now() / 1000) + 60 })}`;
      const key =
        algorithm === "PS256"
          ? { key: generated.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
          : generated.privateKey;
      const assertion = `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
      const form = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: client,
        scope,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      });
      expect((await endpoint.request(url, "POST", form.toString())).status).toBe(200);
      expect(endpoint.signatureChecks).toBe(1);
      form.set("client_assertion", `${input}.invalid-signature`);
      await expect(endpoint.request(url, "POST", form.toString())).rejects.toThrow();
    },
  );
  it.each(["timeout", "exit", "signal", "oversize", "invalid-certificate", "wrong-key"])(
    "refuses %s subprocess output",
    (fault) => {
      const result = {
        pid: 0,
        status: 0,
        signal: null,
        output: [],
        stdout: Buffer.from(generated.certificate),
        stderr: Buffer.alloc(0),
      } satisfies ReturnType<typeof spawnSync>;
      if (fault === "timeout")
        Object.assign(result, { error: new Error("ETIMEDOUT"), status: null, signal: "SIGKILL" });
      if (fault === "exit") result.status = 1;
      if (fault === "signal") Object.assign(result, { signal: "SIGKILL" });
      if (fault === "oversize") result.stderr = Buffer.alloc(16385);
      if (fault === "invalid-certificate") result.stdout = Buffer.from("invalid certificate");
      vi.mocked(spawnSync).mockReturnValueOnce(result);
      // Only wrong-key may fail at pair verification. Every process/output
      // fault must be rejected for its own reason before that later check.
      const errors: Record<string, string> = {
        timeout: "certificate subprocess failed",
        exit: "certificate subprocess exit",
        signal: "certificate subprocess signal",
        oversize: "certificate subprocess output bound",
        "invalid-certificate": "invalid generated certificate",
        "wrong-key": "certificate/key pair",
      };
      const expected = errors[fault];
      assert.ok(expected);
      expect(() => createRuntimeCertificate(freshDeadline())).toThrow(expected);
    },
  );
});
