import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  collectUndiciQualification,
  undiciCases,
} from "../../scripts/fork-linux/security-consumer-manifest.mjs";

function fixture() {
  const records = new Map<string, ReturnType<typeof make>>();
  function make(version: string) {
    return {
      schema: "installed-undici-proof-v1",
      passed: true,
      platform: "linux",
      arch: "x64",
      node: `v${version}`,
      identity: {
        name: "undici",
        version: "8.12.2",
        packageRelative: "node_modules/undici/package.json",
        packageSha256: "16723528eaa06df7f3b29ea52584e9127608fd9e8de066c39339aa806ad9da84",
      },
      cases: [...undiciCases],
      caseCounts: { passed: 9, receivedRequests: 9, queuedAdmitted: 0 },
      cleanup: { sockets: 0, serversClosed: true, dispatchersDestroyed: true },
      limits: { perPhaseMs: 2000, cleanupPhaseMs: 3000, loopbackOnly: true },
      elapsedMs: 50,
    };
  }
  for (const prefix of ["installed", "restored"])
    for (const version of ["24.22.1", "24.22.0"])
      records.set(`${prefix}-undici-proof-${version}.json`, make(version));
  return {
    records,
    run: () => collectUndiciQualification(async (name: string) => records.get(name)),
  };
}

describe("installed security consumer evidence", () => {
  it("requires both real proxy modes and cancellation on all four installed runtime paths", async () => {
    expect(await fixture().run()).toMatchObject({ passed: true, combinations: 4 });
  });
  it.each([
    "missing",
    "old-runtime",
    "different-bytes",
    "forwarding-missing",
    "queued-admitted",
    "socket-open",
    "escaped",
    "longer-budget",
    "failed",
  ])("rejects %s evidence", async (fault) => {
    const f = fixture();
    const name = "restored-undici-proof-24.22.0.json";
    const proof = f.records.get(name);
    assert.ok(proof);
    if (fault === "missing") f.records.delete(name);
    if (fault === "old-runtime") proof.identity.version = "8.11.2";
    if (fault === "different-bytes") proof.identity.packageSha256 = "0".repeat(64);
    if (fault === "forwarding-missing") proof.cases.pop();
    if (fault === "queued-admitted") proof.caseCounts.queuedAdmitted = 1;
    if (fault === "socket-open") proof.cleanup.sockets = 1;
    if (fault === "escaped") proof.identity.packageRelative = "../undici/package.json";
    if (fault === "longer-budget") proof.limits.perPhaseMs = 3000;
    if (fault === "failed") proof.passed = false;
    await expect(f.run()).rejects.toThrow();
  });
});
