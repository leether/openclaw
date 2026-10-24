import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { officialMsal, parents } from "../../scripts/fork-linux/msal/identity.mjs";
import {
  collectMsalQualification,
  msalScenarios,
} from "../../scripts/fork-linux/security-consumer-manifest.mjs";

function fixture() {
  const hash = "a".repeat(64);
  const capture = {
    schema: "msal-consumer-contract-v1",
    passed: true,
    stage: "capture",
    node: "v24.22.1",
    platform: "linux",
    arch: "x64",
    parents: parents.map(([name, version]) => ({
      name,
      version,
      packageSha256: hash,
      entrySha256: hash,
      msal: {
        name: "@azure/msal-node",
        ...officialMsal,
        commonVersion: "16.14.2",
        commonPackageSha256: hash,
      },
    })),
  };
  const audit = { metadata: { vulnerabilities: { high: 0, critical: 0 } } };
  function make(version: string) {
    return {
      schema: "msal-consumer-installed-proof-v1",
      passed: true,
      stage: "passed",
      platform: "linux",
      arch: "x64",
      node: `v${version}`,
      contractSha256: hash,
      identityReverifiedAfterExecution: true,
      noLiveAzureAuthorizationClaim: true,
      identity: capture.parents.map((parent) => ({
        ...parent,
        parentRelative: `node_modules/${parent.name}`,
        msal: { ...parent.msal, relative: "node_modules/@azure/msal-node" },
      })),
      cells: msalScenarios.map((scenario) => ({
        scenario,
        result: {
          passed: true,
          exitCode: 0,
          signal: null,
          failure: null,
          closed: true,
          elapsedMs: 15,
          outputBytes: 200,
          proof: {
            schema: "msal-consumer-scenario-v1",
            scenario,
            passed: true,
            noOutbound: true,
            socketAttempts: 0,
            serverListenCalls: 0,
            cases: [
              "real-consumer-acquire-and-cache",
              "rejection-not-cached",
              "transport-abort-rejects-without-success-cache",
            ].map((name) => ({ name, passed: true })),
            signatureChecks: scenario.includes("certificate") ? 2 : 0,
            certificateGeneration: scenario.includes("certificate")
              ? {
                  generatedAtRuntime: true,
                  generationMode: "openssl-req-newkey-stdout-v1",
                  keyBits: 2048,
                  parentRemainingAtStartMs: 29900,
                  parentRemainingBeforeOpenSslMs: 29890,
                  keyAndCertificateGenerationMs: 10,
                  totalElapsedMs: 20,
                  privateKeyPersisted: false,
                  pairVerified: true,
                  openssl: {
                    exitCode: 0,
                    signal: null,
                    closed: true,
                    elapsedMs: 10,
                    outputBytes: 1000,
                  },
                }
              : null,
            tokenRequests: scenario === "teams-managed-system" ? 2 : 1,
            authContract: {
              mode:
                scenario === "teams-managed-system"
                  ? "system-federated"
                  : scenario.includes("managed")
                    ? "user-assigned"
                    : scenario.includes("certificate")
                      ? "certificate"
                      : "secret",
              managedRequests: scenario.includes("managed") ? 1 : 0,
              oauthRequests:
                !scenario.includes("managed") || scenario === "teams-managed-system" ? 1 : 0,
              headerChecks: scenario.includes("managed") ? 1 : 0,
              resourceChecks: scenario.includes("managed") ? 1 : 0,
              selectorChecks: scenario.includes("managed") ? 1 : 0,
              federationAssertionMatches: scenario === "teams-managed-system" ? 1 : 0,
              exchangeTokenHashes: scenario === "teams-managed-system" ? [hash] : [],
            },
            callerCancellation: {
              optionAccepted: scenario.startsWith("azure-"),
              sourceReleasedAndJoined: true,
              beforeRelease: {
                actualEndpointStillOpen: true,
                requestPromiseSettled: false,
                transportSignal: { present: false, aborted: false },
              },
              outcome: { kind: "fulfilled", hasToken: true },
            },
          },
        },
      })),
    };
  }
  const runtime = new Map<string, ReturnType<typeof make>>();
  for (const prefix of ["installed", "restored"]) {
    for (const version of ["24.22.1", "24.22.0"]) {
      runtime.set(`${prefix}-msteams-proof-${version}.json`, make(version));
    }
  }
  const run = () =>
    collectMsalQualification(
      async (name: string) =>
        name === "msteams-capture.json"
          ? capture
          : name === "msteams-installed-npm-audit.json"
            ? audit
            : runtime.get(name),
      async () => hash,
    );
  return { capture, audit, runtime, run };
}

describe("actual Teams/MSAL proof aggregation", () => {
  it("requires both parent identities and all seven real-consumer cells on four paths", async () => {
    expect(await fixture().run()).toMatchObject({ passed: true, combinations: 4 });
  });
  it.each([
    "missing",
    "old-msal",
    "wrong-common",
    "wrong-parent",
    "old-capture",
    "outside-plugin",
    "not-reverified",
    "high-audit",
    "missing-cell",
    "missing-case",
    "not-signed",
    "static-key",
    "wrong-generation-mode",
    "missing-generation-time",
    "negative-generation-time",
    "generation-timeout",
    "generation-time-disagrees",
    "total-before-generation",
    "total-timeout",
    "wrong-key-size",
    "missing-parent-deadline",
    "exhausted-parent-deadline",
    "persisted-key",
    "pair-unverified",
    "openssl-open",
    "openssl-timeout",
    "openssl-output",
    "real-outbound",
    "not-joined",
    "server-listen",
    "old-node",
    "child-open",
    "wrong-identity-route",
    "unchecked-header",
    "unchecked-resource",
    "missing-federation-join",
    "missing-issued-token",
  ])("rejects %s evidence", async (fault) => {
    const f = fixture();
    const name = "restored-msteams-proof-24.22.0.json";
    const proof = f.runtime.get(name);
    assert.ok(proof);
    const parent = proof.identity[0];
    const child = proof.cells[1]?.result;
    assert.ok(parent && child);
    const managed = proof.cells[2]?.result.proof.authContract;
    const federation = proof.cells[6]?.result.proof.authContract;
    assert.ok(managed && federation);
    if (fault === "missing") {
      f.runtime.delete(name);
    }
    if (fault === "old-msal") {
      parent.msal.version = "5.6.0";
    }
    if (fault === "wrong-common") {
      parent.msal.commonVersion = "old";
    }
    if (fault === "wrong-parent") {
      parent.version = "4.0.0";
    }
    if (fault === "old-capture") {
      proof.contractSha256 = "b".repeat(64);
    }
    if (fault === "outside-plugin") {
      parent.parentRelative = "../other-parent";
    }
    if (fault === "not-reverified") {
      proof.identityReverifiedAfterExecution = false;
    }
    if (fault === "high-audit") {
      f.audit.metadata.vulnerabilities.high = 1;
    }
    if (fault === "missing-cell") {
      proof.cells.pop();
    }
    if (fault === "missing-case") {
      child.proof.cases.pop();
    }
    if (fault === "not-signed") {
      child.proof.signatureChecks = 0;
    }
    const generation = child.proof.certificateGeneration;
    assert.ok(generation);
    if (fault === "static-key") {
      generation.generatedAtRuntime = false;
    }
    if (fault === "wrong-generation-mode") {
      generation.generationMode = "node-keygen-stdin";
    }
    if (fault === "missing-generation-time") {
      generation.keyAndCertificateGenerationMs = Number.NaN;
    }
    if (fault === "negative-generation-time") {
      generation.keyAndCertificateGenerationMs = -1;
    }
    if (fault === "generation-timeout") {
      generation.keyAndCertificateGenerationMs = 5001;
    }
    if (fault === "generation-time-disagrees") {
      generation.keyAndCertificateGenerationMs = 9;
    }
    if (fault === "total-before-generation") {
      generation.totalElapsedMs = 9;
    }
    if (fault === "total-timeout") {
      generation.totalElapsedMs = 25000;
    }
    if (fault === "wrong-key-size") {
      generation.keyBits = 1024;
    }
    if (fault === "missing-parent-deadline") {
      generation.parentRemainingAtStartMs = Number.NaN;
    }
    if (fault === "exhausted-parent-deadline") {
      generation.parentRemainingBeforeOpenSslMs = 6999;
    }
    if (fault === "persisted-key") {
      generation.privateKeyPersisted = true;
    }
    if (fault === "pair-unverified") {
      generation.pairVerified = false;
    }
    if (fault === "openssl-open") {
      generation.openssl.closed = false;
    }
    if (fault === "openssl-timeout") {
      generation.openssl.elapsedMs = 5001;
    }
    if (fault === "openssl-output") {
      generation.openssl.outputBytes = 16385;
    }
    if (fault === "real-outbound") {
      child.proof.socketAttempts = 1;
    }
    if (fault === "not-joined") {
      child.proof.callerCancellation.sourceReleasedAndJoined = false;
    }
    if (fault === "server-listen") {
      child.proof.serverListenCalls = 1;
    }
    if (fault === "old-node") {
      proof.node = "v24.21.0";
    }
    if (fault === "child-open") {
      child.closed = false;
    }
    if (fault === "wrong-identity-route") {
      managed.mode = "system-federated";
    }
    if (fault === "unchecked-header") {
      managed.headerChecks = 0;
    }
    if (fault === "unchecked-resource") {
      managed.resourceChecks = 0;
    }
    if (fault === "missing-federation-join") {
      federation.federationAssertionMatches = 0;
    }
    if (fault === "missing-issued-token") {
      federation.exchangeTokenHashes = [];
    }
    await expect(f.run()).rejects.toThrow();
  });
});
