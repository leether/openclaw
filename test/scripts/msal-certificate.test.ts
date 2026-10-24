import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
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
  it("captures one bounded OpenSSL-generated RSA-2048 pair without descriptor filenames", () => {
    const [file, args, options] = vi.mocked(spawnSync).mock.calls[0] ?? [];
    expect(file).toBe("/usr/bin/openssl");
    expect(args).toEqual([
      "req",
      "-new",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
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
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.ok(options);
    expect(options.input).toBeUndefined();
    expect(
      new X509Certificate(generated.certificate).publicKey.asymmetricKeyDetails?.modulusLength,
    ).toBe(2048);
    expect(generated.proof).toMatchObject({
      generatedAtRuntime: true,
      generationMode: "openssl-req-newkey-stdout-v1",
      privateKeyPersisted: false,
      keyBits: 2048,
      pairVerified: true,
      openssl: { closed: true, exitCode: 0, signal: null },
    });
    expect(generated.proof.openssl.elapsedMs).toBeLessThanOrEqual(5000);
    expect(generated.proof.keyAndCertificateGenerationMs).toBe(generated.proof.openssl.elapsedMs);
    expect(generated.proof.totalElapsedMs).toBeGreaterThanOrEqual(
      generated.proof.keyAndCertificateGenerationMs,
    );
    expect(generated.proof.totalElapsedMs).toBeLessThan(25000);
  });
  it("refuses an already consumed parent budget before launching OpenSSL", () => {
    vi.spyOn(process.hrtime, "bigint").mockReturnValue(24000000000n);
    expect(() => createRuntimeCertificate(30000000000n)).toThrow(
      "parent deadline before certificate generation",
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it("deducts startup and preparation from the original deadline before OpenSSL", () => {
    vi.spyOn(process.hrtime, "bigint")
      .mockReturnValueOnce(11000000000n)
      .mockReturnValue(24000000000n);
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
  it.each([
    "timeout",
    "exit",
    "signal",
    "oversize",
    "duplicate-key",
    "duplicate-certificate",
    "missing-key",
    "missing-certificate",
    "extra-content",
    "legacy-key-label",
    "invalid-key",
    "invalid-certificate",
    "wrong-key",
  ])("refuses %s subprocess output", (fault) => {
    const result = {
      pid: 0,
      status: 0,
      signal: null,
      output: [],
      stdout: Buffer.from(`${generated.privateKey}\n${generated.certificate}\n`),
      stderr: Buffer.alloc(0),
    } satisfies ReturnType<typeof spawnSync>;
    if (fault === "timeout") {
      Object.assign(result, { error: new Error("ETIMEDOUT"), status: null, signal: "SIGKILL" });
    }
    if (fault === "exit") {
      result.status = 1;
    }
    if (fault === "signal") {
      Object.assign(result, { signal: "SIGKILL" });
    }
    if (fault === "oversize") {
      result.stderr = Buffer.alloc(16385);
    }
    if (fault === "duplicate-key") {
      result.stdout = Buffer.from(`${generated.privateKey}\n${result.stdout.toString("utf8")}`);
    }
    if (fault === "duplicate-certificate") {
      result.stdout = Buffer.from(`${result.stdout.toString("utf8")}\n${generated.certificate}`);
    }
    if (fault === "missing-key") {
      result.stdout = Buffer.from(generated.certificate);
    }
    if (fault === "missing-certificate") {
      result.stdout = Buffer.from(generated.privateKey);
    }
    if (fault === "extra-content") {
      result.stdout = Buffer.from(`${result.stdout.toString("utf8")}\nextra content`);
    }
    if (fault === "legacy-key-label") {
      result.stdout = Buffer.from(
        result.stdout.toString().replaceAll("PRIVATE KEY", "RSA PRIVATE KEY"),
      );
    }
    if (fault === "invalid-key") {
      result.stdout = Buffer.from(
        `${generated.privateKey.replace(/\r?\n[A-Za-z0-9+/=\r\n]+(?=-----END )/, "\nYmFk\n")}\n${generated.certificate}`,
      );
    }
    if (fault === "invalid-certificate") {
      result.stdout = Buffer.from(
        `${generated.privateKey}\n${generated.certificate.replace(/\r?\n[A-Za-z0-9+/=\r\n]+(?=-----END )/, "\nYmFk\n")}`,
      );
    }
    if (fault === "wrong-key") {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      result.stdout = Buffer.from(
        `${privateKey.export({ type: "pkcs8", format: "pem" })}\n${generated.certificate}`,
      );
    }
    vi.mocked(spawnSync).mockReturnValueOnce(result);
    // Only wrong-key may fail at pair verification. Every process/output
    // fault must be rejected for its own reason before that later check.
    const errors: Record<string, string> = {
      timeout: "certificate subprocess failed",
      exit: "certificate subprocess exit",
      signal: "certificate subprocess signal",
      oversize: "certificate subprocess output bound",
      "duplicate-key": "invalid generated PEM layout",
      "duplicate-certificate": "invalid generated PEM layout",
      "missing-key": "invalid generated PEM layout",
      "missing-certificate": "invalid generated PEM layout",
      "extra-content": "invalid generated PEM layout",
      "legacy-key-label": "invalid generated PEM layout",
      "invalid-key": "invalid generated private key",
      "invalid-certificate": "invalid generated certificate",
      "wrong-key": "certificate/key pair",
    };
    const expected = errors[fault];
    assert.ok(expected);
    expect(() => createRuntimeCertificate(freshDeadline())).toThrow(expected);
  });
  it.each([
    {
      fault: "subprocess deadline",
      afterProcess: 5001000000n,
      finished: 5001000000n,
      deadline: 30000000000n,
      expected: "certificate subprocess deadline",
    },
    {
      fault: "total deadline",
      afterProcess: 1000000n,
      finished: 25000000000n,
      deadline: 30000000000n,
      expected: "leave time for the authentication scenarios",
    },
    {
      fault: "parent deadline",
      afterProcess: 1000000n,
      finished: 8000000000n,
      deadline: 7000000000n,
      expected: "parent certificate deadline",
    },
  ])(
    "refuses $fault after process completion",
    ({ afterProcess, finished, deadline, expected }) => {
      vi.mocked(spawnSync).mockReturnValueOnce({
        pid: 0,
        status: 0,
        signal: null,
        output: [],
        stdout: Buffer.from(`${generated.privateKey}\n${generated.certificate}\n`),
        stderr: Buffer.alloc(0),
      });
      vi.spyOn(process.hrtime, "bigint")
        .mockReturnValueOnce(0n)
        .mockReturnValueOnce(0n)
        .mockReturnValueOnce(afterProcess)
        .mockReturnValue(finished);
      expect(() => createRuntimeCertificate(deadline)).toThrow(expected);
    },
  );
});
