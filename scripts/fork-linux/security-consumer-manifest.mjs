import assert from "node:assert/strict";
import { hashesOnly, officialMsal, parents } from "./msal/identity.mjs";

export const msalScenarios = [
  "azure-secret",
  "azure-certificate",
  "azure-managed",
  "teams-secret",
  "teams-certificate-provider",
  "teams-managed-user",
  "teams-managed-system",
];
const msalCases = [
  "real-consumer-acquire-and-cache",
  "rejection-not-cached",
  "transport-abort-rejects-without-success-cache",
];

export async function collectMsalQualification(read, hashFile) {
  const capture = await read("msteams-capture.json");
  assert.equal(capture.schema, "msal-consumer-contract-v1");
  assert.equal(capture.passed, true);
  assert.equal(capture.stage, "capture");
  assert.equal(capture.node, "v24.22.1");
  assert.equal(capture.platform, "linux");
  assert.equal(capture.arch, "x64");
  assert.equal(capture.parents.length, 2);
  for (const [index, [name, version]] of parents.entries()) {
    const parent = capture.parents[index];
    assert.equal(parent.name, name);
    assert.equal(parent.version, version);
    for (const key of ["packageSha256", "entrySha256"]) {
      assert.match(parent[key], /^[a-f0-9]{64}$/);
    }
    assert.equal(parent.msal.name, "@azure/msal-node");
    for (const [key, expected] of Object.entries(officialMsal)) {
      assert.equal(parent.msal[key], expected);
    }
    assert.equal(parent.msal.commonVersion, "16.14.2");
    assert.match(parent.msal.commonPackageSha256, /^[a-f0-9]{64}$/);
  }
  const contractSha256 = await hashFile("msteams-capture.json");
  const audit = await read("msteams-installed-npm-audit.json");
  assert.equal(audit.metadata.vulnerabilities.high, 0);
  assert.equal(audit.metadata.vulnerabilities.critical, 0);
  let firstIdentity;
  const cancellationObservations = [];
  for (const version of ["24.22.1", "24.22.0"]) {
    for (const prefix of ["installed", "restored"]) {
      const proof = await read(`${prefix}-msteams-proof-${version}.json`);
      assert.equal(proof.schema, "msal-consumer-installed-proof-v1");
      assert.equal(proof.passed, true);
      assert.equal(proof.stage, "passed");
      assert.equal(proof.platform, "linux");
      assert.equal(proof.arch, "x64");
      assert.equal(proof.node, `v${version}`);
      assert.equal(proof.contractSha256, contractSha256);
      assert.equal(proof.identityReverifiedAfterExecution, true);
      assert.equal(proof.noLiveAzureAuthorizationClaim, true);
      assert.deepEqual(hashesOnly(proof.identity), capture.parents);
      for (const parent of proof.identity) {
        for (const relative of [parent.parentRelative, parent.msal.relative]) {
          assert.equal(typeof relative, "string");
          assert.ok(relative.split("/").every((part) => part && part !== "." && part !== ".."));
          assert.equal(relative.includes("\\"), false);
        }
      }
      if (firstIdentity) {
        assert.deepEqual(proof.identity, firstIdentity);
      } else {
        firstIdentity = proof.identity;
      }
      assert.deepEqual(
        proof.cells.map((cell) => cell.scenario),
        msalScenarios,
      );
      for (const { scenario, result } of proof.cells) {
        assert.equal(result.passed, true);
        assert.equal(result.exitCode, 0);
        assert.equal(result.signal, null);
        assert.equal(result.failure, null);
        assert.equal(result.closed, true);
        assert.ok(
          Number.isSafeInteger(result.elapsedMs) &&
            result.elapsedMs >= 0 &&
            result.elapsedMs < 30000,
        );
        assert.ok(
          Number.isSafeInteger(result.outputBytes) &&
            result.outputBytes >= 0 &&
            result.outputBytes <= 262144,
        );
        const outcome = result.proof;
        assert.equal(outcome.schema, "msal-consumer-scenario-v1");
        assert.equal(outcome.scenario, scenario);
        assert.equal(outcome.passed, true);
        assert.equal(outcome.noOutbound, true);
        assert.equal(outcome.socketAttempts, 0);
        assert.equal(outcome.serverListenCalls, 0);
        assert.deepEqual(
          outcome.cases.map((item) => item.name),
          msalCases,
        );
        assert.ok(outcome.cases.every((item) => item.passed === true));
        const auth = outcome.authContract;
        const managed = scenario.includes("managed");
        const federated = scenario === "teams-managed-system";
        const expectedMode = federated
          ? "system-federated"
          : managed
            ? "user-assigned"
            : scenario.includes("certificate")
              ? "certificate"
              : "secret";
        assert.equal(auth.mode, expectedMode);
        for (const count of [
          auth.managedRequests,
          auth.oauthRequests,
          auth.federationAssertionMatches,
        ]) {
          assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 32);
        }
        assert.equal(auth.headerChecks, auth.managedRequests);
        assert.equal(auth.resourceChecks, auth.managedRequests);
        assert.equal(auth.selectorChecks, auth.managedRequests);
        assert.equal(outcome.tokenRequests, auth.managedRequests + auth.oauthRequests);
        assert.equal(auth.managedRequests > 0, managed);
        assert.equal(auth.oauthRequests > 0, !managed || federated);
        assert.equal(auth.federationAssertionMatches, federated ? auth.oauthRequests : 0);
        assert.equal(auth.exchangeTokenHashes.length > 0, federated);
        assert.equal(new Set(auth.exchangeTokenHashes).size, auth.exchangeTokenHashes.length);
        assert.ok(auth.exchangeTokenHashes.every((value) => /^[a-f0-9]{64}$/.test(value)));
        if (scenario.includes("certificate")) {
          assert.ok(outcome.signatureChecks > 0);
          const generated = outcome.certificateGeneration;
          assert.equal(generated.generatedAtRuntime, true);
          assert.equal(generated.keyBits, 2048);
          assert.ok(
            Number.isSafeInteger(generated.parentRemainingAtStartMs) &&
              generated.parentRemainingAtStartMs >= 7000 &&
              generated.parentRemainingAtStartMs <= 30000,
          );
          assert.ok(
            Number.isSafeInteger(generated.parentRemainingBeforeOpenSslMs) &&
              generated.parentRemainingBeforeOpenSslMs >= 7000 &&
              generated.parentRemainingBeforeOpenSslMs <= generated.parentRemainingAtStartMs,
          );
          assert.ok(
            Number.isSafeInteger(generated.keyGenerationMs) &&
              generated.keyGenerationMs >= 0 &&
              generated.keyGenerationMs < 20000,
          );
          assert.ok(
            Number.isSafeInteger(generated.totalElapsedMs) &&
              generated.totalElapsedMs >= generated.keyGenerationMs &&
              generated.totalElapsedMs < 25000,
          );
          assert.equal(generated.privateKeyPersisted, false);
          assert.equal(generated.pairVerified, true);
          assert.equal(generated.openssl.exitCode, 0);
          assert.equal(generated.openssl.signal, null);
          assert.equal(generated.openssl.closed, true);
          assert.ok(
            Number.isSafeInteger(generated.openssl.elapsedMs) &&
              generated.openssl.elapsedMs >= 0 &&
              generated.openssl.elapsedMs <= 5000,
          );
          assert.ok(
            Number.isSafeInteger(generated.openssl.outputBytes) &&
              generated.openssl.outputBytes > 0 &&
              generated.openssl.outputBytes <= 16384,
          );
        } else {
          assert.equal(outcome.certificateGeneration, null);
        }
        assert.equal(outcome.callerCancellation.sourceReleasedAndJoined, true);
        assert.equal(outcome.callerCancellation.beforeRelease.actualEndpointStillOpen, true);
        assert.equal(
          typeof outcome.callerCancellation.beforeRelease.requestPromiseSettled,
          "boolean",
        );
        assert.equal(
          typeof outcome.callerCancellation.beforeRelease.transportSignal.present,
          "boolean",
        );
        assert.equal(
          typeof outcome.callerCancellation.beforeRelease.transportSignal.aborted,
          "boolean",
        );
        assert.equal(outcome.callerCancellation.optionAccepted, scenario.startsWith("azure-"));
        assert.ok(["fulfilled", "rejected"].includes(outcome.callerCancellation.outcome.kind));
        if (outcome.callerCancellation.outcome.kind === "fulfilled") {
          assert.equal(outcome.callerCancellation.outcome.hasToken, true);
        }
        cancellationObservations.push({
          prefix,
          node: version,
          scenario,
          ...outcome.callerCancellation,
        });
      }
    }
  }
  return {
    passed: true,
    contractSha256,
    parents: capture.parents,
    scenarios: msalScenarios,
    combinations: 4,
    productionAudit: audit.metadata.vulnerabilities,
    cancellationObservations,
  };
}

export const undiciCases = [
  "direct-http1-body",
  "queued-cancel-no-admission",
  "headers-cancel-peer-closed",
  "body-cancel-peer-closed",
  "explicit-connect-proxy",
  "proxy-cancel-peer-closed",
  "environment-connect-proxy",
  "environment-forward-proxy",
  "forward-proxy-cancel-peer-closed",
];

export async function collectUndiciQualification(read) {
  let identity;
  for (const version of ["24.22.1", "24.22.0"]) {
    for (const prefix of ["installed", "restored"]) {
      const proof = await read(`${prefix}-undici-proof-${version}.json`);
      assert.equal(proof.schema, "installed-undici-proof-v1");
      assert.equal(proof.passed, true);
      assert.equal(proof.platform, "linux");
      assert.equal(proof.arch, "x64");
      assert.equal(proof.node, `v${version}`);
      assert.equal(proof.identity.name, "undici");
      assert.equal(proof.identity.version, "8.12.2");
      assert.equal(
        proof.identity.packageSha256,
        "16723528eaa06df7f3b29ea52584e9127608fd9e8de066c39339aa806ad9da84",
      );
      assert.ok(
        proof.identity.packageRelative
          .split("/")
          .every((part) => part && part !== ".." && part !== "."),
      );
      assert.equal(proof.identity.packageRelative.includes("\\"), false);
      if (identity) {
        assert.deepEqual(proof.identity, identity);
      } else {
        identity = proof.identity;
      }
      assert.deepEqual(proof.cases, undiciCases);
      assert.deepEqual(proof.caseCounts, { passed: 9, receivedRequests: 9, queuedAdmitted: 0 });
      assert.deepEqual(proof.cleanup, {
        sockets: 0,
        serversClosed: true,
        dispatchersDestroyed: true,
      });
      assert.deepEqual(proof.limits, {
        perPhaseMs: 2000,
        cleanupPhaseMs: 3000,
        loopbackOnly: true,
      });
      assert.ok(
        Number.isSafeInteger(proof.elapsedMs) && proof.elapsedMs >= 0 && proof.elapsedMs < 60000,
      );
    }
  }
  return { passed: true, identity, cases: undiciCases, combinations: 4 };
}
