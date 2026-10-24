import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";

// Only certificate scenarios call this. Key material stays in the child process
// and the stdin pipe; no private-key fixture or temporary file is needed.
/** @param {bigint} deadlineNs Parent's absolute, same-host monotonic deadline. */
export function createRuntimeCertificate(deadlineNs) {
  assert.equal(typeof deadlineNs, "bigint");
  const started = process.hrtime.bigint();
  const parentRemainingAtStartMs = Number((deadlineNs - started) / 1000000n);
  assert.ok(
    parentRemainingAtStartMs >= 7000 && parentRemainingAtStartMs <= 30000,
    "parent deadline before certificate key generation",
  );
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const afterKeyGeneration = process.hrtime.bigint();
  const keyGenerationMs = Math.ceil(Number(afterKeyGeneration - started) / 1000000);
  assert.ok(keyGenerationMs < 20000, "leave time for certificate creation and signing");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const start = process.hrtime.bigint();
  const parentRemainingBeforeOpenSslMs = Number((deadlineNs - start) / 1000000n);
  // Startup, inspect and key generation consume the original parent's budget.
  // Reserve the full five-second child limit and two seconds to join/finish.
  assert.ok(parentRemainingBeforeOpenSslMs >= 7000, "parent deadline before OpenSSL");
  const result = spawnSync(
    "/usr/bin/openssl",
    [
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
      fileURLToPath(new URL("./certificate.cnf", import.meta.url)),
    ],
    {
      input: pem,
      encoding: null,
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 8192,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const elapsedMs = Math.ceil(Number(process.hrtime.bigint() - start) / 1000000);
  const outputBytes = (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0);
  // spawnSync joins its owned process, including after SIGKILL on a limit.
  assert.equal(result.error, undefined, "certificate subprocess failed");
  assert.equal(result.status, 0, "certificate subprocess exit");
  assert.equal(result.signal, null, "certificate subprocess signal");
  assert.ok(elapsedMs <= 5000, "certificate subprocess deadline");
  assert.ok(outputBytes <= 16384, "certificate subprocess output bound");
  const certificate = result.stdout.toString("utf8");
  let parsed;
  try {
    parsed = new X509Certificate(certificate);
  } catch {
    throw new Error("invalid generated certificate");
  }
  assert.equal(parsed.subject, "CN=msal-qualification.invalid");
  assert.equal(parsed.issuer, parsed.subject);
  assert.equal(parsed.publicKey.asymmetricKeyType, "rsa");
  assert.equal(parsed.publicKey.asymmetricKeyDetails?.modulusLength, 2048);
  assert.equal(parsed.checkPrivateKey(privateKey), true, "certificate/key pair");
  assert.equal(parsed.verify(publicKey), true, "self-signed certificate");
  const finished = process.hrtime.bigint();
  const totalElapsedMs = Math.ceil(Number(finished - started) / 1000000);
  assert.ok(totalElapsedMs < 25000, "leave time for the authentication scenarios");
  assert.ok(finished < deadlineNs, "parent certificate deadline");
  return {
    certificate,
    privateKey: pem.toString(),
    proof: {
      generatedAtRuntime: true,
      keyBits: 2048,
      keyGenerationMs,
      totalElapsedMs,
      parentRemainingAtStartMs,
      parentRemainingBeforeOpenSslMs,
      privateKeyPersisted: false,
      pairVerified: true,
      openssl: { exitCode: 0, signal: null, closed: true, elapsedMs, outputBytes },
    },
  };
}
