// Record the exact published-source input and complete, qualified CI installation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const artifactRoot = process.env.FORK_ARTIFACT_DIR;
assert.ok(artifactRoot && process.env.QUALIFIED_SHA);
const git = (...args) => execFileSync("git", args, { encoding: "utf8", timeout: 10000 }).trim();
assert.equal(git("rev-parse", "HEAD"), process.env.QUALIFIED_SHA);
const read = async (name) => JSON.parse(await fs.readFile(path.join(artifactRoot, name), "utf8"));
const installedAudit = await read("installed-npm-audit.json");
assert.equal(installedAudit.metadata.vulnerabilities.high, 0);
assert.equal(installedAudit.metadata.vulnerabilities.critical, 0);
const native = await Promise.all(
  ["initial", "candidate", "rollback"].map(async (phase) => {
    const report = await read(`native-${phase}.json`);
    assert.equal(report.passed, true);
    assert.equal(report.mode, phase);
    assert.equal(report.node, phase === "candidate" ? "v24.22.1" : "v24.22.0");
    assert.equal(report.native.length, 7);
    assert.equal(report.sqliteRows, phase === "initial" ? 1 : 2);
    return report;
  }),
);
for (const [index, entry] of native[0].native.entries()) {
  for (const report of native.slice(1)) {
    assert.equal(report.native[index].name, entry.name);
    assert.equal(report.native[index].sha256, entry.sha256);
  }
}
const restoredNative = await read("restored-native.json");
assert.equal(restoredNative.passed, true);
assert.equal(restoredNative.node, "v24.22.1");
assert.equal(restoredNative.native.length, 7);
for (const [index, entry] of native[1].native.entries()) {
  assert.equal(restoredNative.native[index].name, entry.name);
  assert.equal(restoredNative.native[index].sha256, entry.sha256);
}
const httpAssertions = [
  "unauthenticated-rejected",
  "stale-owner-rejected",
  "installed-http-ack-answer-480000",
  "installed-http-ack-answer-240000",
  "cancelled-http-retains-actual-tool-drain",
  "actual-tool-settlement-releases-drain",
];
const httpByRuntime = {};
const restoredHttpByRuntime = {};
for (const version of ["24.22.1", "24.22.0"]) {
  for (const prefix of ["installed", "restored"]) {
    const reports = prefix === "installed" ? httpByRuntime : restoredHttpByRuntime;
    const proof = await read(`${prefix}-http-proof-${version}.json`);
    assert.equal(proof.passed, true);
    assert.equal(proof.node, `v${version}`);
    for (const assertion of httpAssertions) {
      assert.ok(proof.assertions.includes(assertion), `${prefix} ${version}: ${assertion}`);
    }
    assert.equal(proof.finalDrain.idle, true);
    reports[version] = proof.assertions;
  }
}
const files = {};
for (const name of [
  "openclaw-candidate.tgz",
  "openclaw-linux-x64-runtime.tar.gz",
  "source-pnpm-lock.yaml",
  "installed-package-lock.json",
  "installed-dependencies.json",
  "installed-npm-audit.json",
  "node-verification/node-v24.22.0-linux-x64.tar.xz",
  "node-verification/node-v24.22.1-linux-x64.tar.xz",
]) {
  const file = path.join(artifactRoot, name);
  const stat = await fs.stat(file);
  assert.ok(stat.size > 0 && stat.size < 4 * 1024 ** 3, name);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  files[name] = { bytes: stat.size, sha256: hash.digest("hex") };
}
const report = {
  schemaVersion: 1,
  passed: true,
  syntheticOnly: true,
  source: { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") },
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  runner: { image: process.env.ImageOS, version: process.env.ImageVersion },
  workflow: {
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
  },
  build: "full pnpm build and canonical package-openclaw-for-docker",
  dependencyBoundary:
    "source frozen pnpm lock; standalone npm resolution captured in installed-package-lock.json and installed-dependencies.json",
  installedProductionAudit: installedAudit.metadata.vulnerabilities,
  offlineRestore:
    "runtime archive includes the complete npm installation and Linux production dependencies; verified Node 24.22.0 and 24.22.1 archives are included separately",
  limitations: [
    "Synthetic local provider and tool only",
    "480/240-second values verify the budget protocol with fast mock answers, not elapsed eight/four-minute execution",
    "Does not prove production performance, live configuration or first migration safety",
  ],
  nativePhases: native.map(({ node, mode, sqliteRows }) => ({ node, mode, sqliteRows })),
  httpByRuntime,
  restoration: {
    freshPrefix: true,
    completeArchiveCompared: true,
    nativePassed: true,
    httpByRuntime: restoredHttpByRuntime,
  },
  retention:
    "GitHub Actions artifacts expire after 90 days; transfer and verify in a separately approved durable archive before expiry",
  files,
};
await fs.writeFile(
  path.join(artifactRoot, "qualification.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({ passed: true, commit: report.source.commit, files: Object.keys(files).length }),
);
