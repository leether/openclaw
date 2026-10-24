import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";

// Only certificate scenarios call this. OpenSSL writes both PEM blocks to its
// captured stdout; no descriptor filename, private-key fixture or file is used.
/** @param {bigint} deadlineNs Parent's absolute, same-host monotonic deadline. */
export function createRuntimeCertificate(deadlineNs) {
  assert.equal(typeof deadlineNs, "bigint");
  /** @type {bigint} */
  const started = process.hrtime.bigint();
  const parentRemainingAtStartMs = Number((deadlineNs - started) / 1000000n);
  assert.ok(
    parentRemainingAtStartMs >= 7000 && parentRemainingAtStartMs <= 30000,
    "parent deadline before certificate generation",
  );
  /** @type {bigint} */
  const start = process.hrtime.bigint();
  const parentRemainingBeforeOpenSslMs = Number((deadlineNs - start) / 1000000n);
  // Startup and inspection consume the original parent's budget.
  // Reserve the full five-second child limit and two seconds to join/finish.
  assert.ok(parentRemainingBeforeOpenSslMs >= 7000, "parent deadline before OpenSSL");
  const result = spawnSync(
    "/usr/bin/openssl",
    [
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
      fileURLToPath(new URL("./certificate.cnf", import.meta.url)),
    ],
    {
      encoding: null,
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 8192,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const keyAndCertificateGenerationMs = Math.ceil(
    Number(process.hrtime.bigint() - start) / 1000000,
  );
  const outputBytes = (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0);
  // spawnSync joins its owned process, including after SIGKILL on a limit.
  assert.equal(result.error, undefined, "certificate subprocess failed");
  assert.equal(result.status, 0, "certificate subprocess exit");
  assert.equal(result.signal, null, "certificate subprocess signal");
  assert.ok(keyAndCertificateGenerationMs <= 5000, "certificate subprocess deadline");
  assert.ok(outputBytes <= 16384, "certificate subprocess output bound");
  const output = result.stdout.toString("utf8");
  const pemPattern =
    /-----BEGIN (PRIVATE KEY|CERTIFICATE)-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END \1-----/g;
  const blocks = [...output.matchAll(pemPattern)];
  const keyBlock = blocks.find((block) => block[1] === "PRIVATE KEY");
  const certificateBlock = blocks.find((block) => block[1] === "CERTIFICATE");
  assert.ok(
    blocks.length === 2 &&
      keyBlock &&
      certificateBlock &&
      output.replace(pemPattern, "").trim() === "",
    "invalid generated PEM layout",
  );
  const pem = keyBlock[0];
  const certificate = certificateBlock[0];
  let privateKey;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new Error("invalid generated private key");
  }
  assert.equal(privateKey.asymmetricKeyType, "rsa", "generated key algorithm");
  assert.equal(privateKey.asymmetricKeyDetails?.modulusLength, 2048, "generated key size");
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
  assert.equal(parsed.verify(parsed.publicKey), true, "self-signed certificate");
  /** @type {bigint} */
  const finished = process.hrtime.bigint();
  const totalElapsedMs = Math.ceil(Number(finished - started) / 1000000);
  assert.ok(totalElapsedMs < 25000, "leave time for the authentication scenarios");
  assert.ok(finished < deadlineNs, "parent certificate deadline");
  return {
    certificate,
    privateKey: pem,
    proof: {
      generatedAtRuntime: true,
      generationMode: "openssl-req-newkey-stdout-v1",
      keyBits: 2048,
      keyAndCertificateGenerationMs,
      totalElapsedMs,
      parentRemainingAtStartMs,
      parentRemainingBeforeOpenSslMs,
      privateKeyPersisted: false,
      pairVerified: true,
      openssl: {
        exitCode: 0,
        signal: null,
        closed: true,
        elapsedMs: keyAndCertificateGenerationMs,
        outputBytes,
      },
    },
  };
}
