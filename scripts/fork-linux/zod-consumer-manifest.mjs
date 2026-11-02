import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  LIMIT,
  WORKER_TIMEOUT_MS,
  parseScopeState,
  verifyKernelReceipts,
} from "./canvas-managed.mjs";
import { readDerivedProbeIdentity } from "./discord/contracts.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const runtimeCases = { registration: 2, jsonlAccepted: 2, jsonlRejected: 9, composition: 2 };
const publicFlags = [
  "handshake",
  "ready",
  "exactNonceSettlement",
  "foreignOriginIgnored",
  "malformedResponseRemainsPending",
  "duplicateResponseNoSecondSettlement",
  "errorRejected",
  "fallbackPreserved",
  "threeCommandsNoRetries",
  "noExternalIO",
];

function linux(report, node) {
  assert.equal(report.passed, true);
  assert.equal(report.platform, "linux");
  assert.equal(report.arch, "x64");
  assert.equal(report.node, `v${node}`);
}

function childFinished(child) {
  assert.equal(child.passed, true);
  assert.equal(child.exitCode, 0);
  assert.equal(child.signal, null);
  assert.equal(child.failure, null);
  assert.equal(child.closed, true);
  assert.ok(child.elapsedMs < 30000);
  assert.ok(child.outputBytes <= 262144);
}

function publicSdk(proof) {
  for (const flag of publicFlags) {
    assert.equal(proof[flag], true, flag);
  }
  assert.equal(proof.pendingCommandsAfterTerminal, 0);
  assert.equal(proof.listenersAfterClose, 0);
  assert.equal(proof.commands, 3);
}

// The aggregate rejects stale/missing per-install evidence. Producer scripts
// perform the actual execution; a successful audit is not consumer proof.
export async function collectConsumerQualification(
  read,
  hashFile,
  sourceContract,
  sourceContractSha256,
) {
  const before = await read("patched-source-inputs-before.json");
  const after = await read("patched-source-inputs-after.json");
  assert.deepEqual(after, before);
  assert.equal(before.passed, true);
  assert.equal(before.lockSha256, await hashFile("source-pnpm-lock.yaml"));
  assert.equal(before.contractSha256, sourceContractSha256);
  assert.equal(before.packages.length, 3);
  for (const expected of sourceContract.packages) {
    const actual = before.packages.filter((item) => item.name === expected.name);
    assert.equal(actual.length, 1);
    assert.equal(actual[0].version, expected.version);
    assert.equal(actual[0].targetTreeSha256, expected.targetTreeSha256);
    assert.equal(actual[0].files, expected.fileCount);
    assert.equal(actual[0].resolvedZodVersion, "4.6.6");
    assert.match(actual[0].resolvedZodPackageSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(actual[0].excludedInstallationMetadata, ["node_modules"]);
  }
  const canvas = await read("canvas-capture.json");
  linux(canvas, "24.22.1");
  assert.equal(canvas.phase, "capture");
  assert.equal(canvas.schemaVersion, 1);
  assert.deepEqual(canvas.caseCounts, runtimeCases);
  assert.equal(canvas.artifactHashes.sourceLock, before.lockSha256);
  assert.equal(canvas.artifactHashes.consumerContract, before.contractSha256);
  assert.deepEqual(
    canvas.patchedInputs,
    before.packages.filter((item) => item.name.startsWith("@a2ui/")),
  );
  const canvasHash = await hashFile("canvas-capture.json");
  const discord = await read("discord-capture.json");
  const derivedProbes = readDerivedProbeIdentity();
  assert.deepEqual(discord.derivedProbes, derivedProbes);
  assert.equal(discord.schema, "discord-installed-contract-v1");
  assert.equal(discord.plugin.name, "@openclaw/discord");
  assert.equal(discord.sdk.name, "@discord/embedded-app-sdk");
  assert.equal(discord.sdk.version, "2.5.0");
  assert.equal(discord.sdk.zod, "4.6.6");
  const sourceSdk = before.packages.find((item) => item.name === discord.sdk.name);
  assert.ok(sourceSdk);
  assert.equal(discord.sdk.zodPackageSha256, sourceSdk.resolvedZodPackageSha256);
  const expectedSdk = sourceContract.packages.find((item) => item.name === discord.sdk.name);
  assert.ok(expectedSdk);
  assert.equal(discord.sdkTree.targetTreeSha256, expectedSdk.targetTreeSha256);
  assert.equal(discord.sourceProvenance.patchSha256, expectedSdk.patchSha256);
  assert.equal(discord.sourceProvenance.sourcePatchSha256, expectedSdk.sourcePatchSha256);
  const discordHash = sha(JSON.stringify(discord));
  const discordAssets = Object.fromEntries(
    discord.assets.map((asset) => [asset.installedPath, asset.sha256]),
  );
  const audit = await read("discord-installed-npm-audit.json");
  assert.equal(audit.metadata.vulnerabilities.high, 0);
  assert.equal(audit.metadata.vulnerabilities.critical, 0);
  let firstDiscordHashes;
  let firstZodRelative;
  for (const version of ["24.22.1", "24.22.0"]) {
    for (const prefix of ["installed", "restored"]) {
      const runtime = await read(`${prefix}-canvas-proof-${version}.json`);
      linux(runtime, version);
      assert.equal(runtime.phase, "runtime");
      assert.equal(runtime.captureSha256, canvasHash);
      assert.deepEqual(runtime.caseCounts, runtimeCases);
      assert.deepEqual(runtime.assertions, canvas.assertions);
      assert.deepEqual(runtime.artifactHashes, {
        bundles: canvas.artifactHashes.bundles,
        runtimeClosure: canvas.artifactHashes.runtimeClosure,
      });
      const sdk = await read(`${prefix}-discord-proof-${version}.json`);
      linux(sdk, version);
      assert.equal(sdk.schema, "discord-installed-proof-v1");
      assert.equal(sdk.identity.pluginName, discord.plugin.name);
      assert.equal(sdk.identity.pluginVersion, discord.plugin.version);
      assert.equal(sdk.identity.sdkName, discord.sdk.name);
      assert.equal(sdk.identity.sdkVersion, "2.5.0");
      assert.equal(sdk.identity.packageFiles, 231);
      assert.equal(sdk.identity.runtimeFiles, 227);
      assert.equal(sdk.identity.resolvedZodVersion, "4.6.6");
      assert.equal(typeof sdk.identity.zodPackageRelative, "string");
      assert.match(sdk.identity.zodPackageRelative, /(?:^|\/)zod\/package\.json$/);
      assert.ok(
        sdk.identity.zodPackageRelative
          .split("/")
          .every((part) => part && part !== ".." && part !== "."),
      );
      assert.equal(sdk.identity.zodPackageRelative.includes("\\"), false);
      assert.equal(sdk.artifactHashes.resolvedZodPackage, discord.sdk.zodPackageSha256);
      if (firstZodRelative) {
        assert.equal(sdk.identity.zodPackageRelative, firstZodRelative);
      } else {
        firstZodRelative = sdk.identity.zodPackageRelative;
      }
      assert.equal(sdk.artifactHashes.expectedContract, discordHash);
      assert.deepEqual(sdk.artifactHashes.derivedProbes, derivedProbes);
      assert.equal(sdk.artifactHashes.sdkCarrierTree, expectedSdk.targetTreeSha256);
      assert.deepEqual(sdk.artifactHashes.staticAssets, discordAssets);
      if (firstDiscordHashes) {
        assert.deepEqual(sdk.artifactHashes, firstDiscordHashes);
      } else {
        firstDiscordHashes = sdk.artifactHashes;
      }
      assert.deepEqual(Object.keys(sdk.formats).toSorted(), ["cjs", "esm"]);
      for (const [format, proof] of Object.entries(sdk.formats)) {
        assert.equal(proof.compatChecks, 86);
        assert.equal(proof.generatedCommands, 13);
        assert.equal(proof.errorCases, 19);
        assert.deepEqual(proof.nativePlainErrorFallback, {
          nativeSendCommand: true,
          plainErrorRejected: true,
          compatibilityFallback: true,
          primaryAndFallbackArgsExact: true,
          distinctNonces: true,
          commandFrames: 2,
          nativeRejections: 1,
          pendingCommandsAfterTerminal: 0,
          listenersAfterClose: 0,
        });
        assert.deepEqual(proof.threeElementsMaxOne, { rejected: true, elementVisits: 0 });
        publicSdk(proof.publicSDK);
        assert.equal(proof.publicSDK.entry.format, format === "esm" ? "mjs" : "cjs");
        assert.equal(proof.publicSDK.entry.kind, "package");
        assert.equal(
          proof.publicSDK.entry.resolver,
          format === "esm" ? "node-esm-import-conditions" : "node-require",
        );
        assert.equal(proof.publicSDK.entry.relative, sdk.identity[`${format}EntryRelative`]);
        assert.deepEqual(Object.keys(proof.children).toSorted(), ["compat", "errors", "publicSDK"]);
        for (const child of Object.values(proof.children)) {
          childFinished(child);
        }
      }
      childFinished(sdk.assets.generatedSdk);
      publicSdk(sdk.assets.generatedSdk.proof);
      assert.equal(sdk.assets.generatedSdk.proof.entry.kind, "asset");
    }
  }
  const browser = await read("canvas-browser/report.json");
  linux(browser, "24.22.1");
  assert.equal(browser.phase, "browser");
  assert.equal(browser.captureSha256, canvasHash);
  assert.deepEqual(browser.caseCounts, { combinations: 4, passed: 4, steps: 20 });
  assert.deepEqual(browser.artifactHashes, {
    installed: canvas.artifactHashes.bundles,
    restored: canvas.artifactHashes.bundles,
  });
  assert.equal(browser.cleanup.browserLeaderExited, true);
  assert.equal(browser.cleanup.cdpClosed, true);
  assert.equal(browser.cleanup.serverClosed, true);
  assert.equal(browser.cleanup.processTreeVerifiedEmpty, true);
  assert.equal(browser.cleanup.requiresOuterProcessTreeVerification, false);
  for (const field of ["closeError", "error", "killError"]) {
    assert.equal(browser.cleanup[field], undefined);
  }
  for (const field of ["externalRequestsBlocked", "webSocketsBlocked", "pageErrors"]) {
    assert.deepEqual(browser[field], []);
  }
  assert.equal(browser.requests.length, 12);
  assert.ok(browser.requests.every((request) => request.method === "GET"));
  assert.equal(browser.browserOutput.limitBytes, 32768);
  assert.equal(browser.browserOutput.limitExceeded, false);
  assert.ok(
    Number.isSafeInteger(browser.browserOutput.bytes) && browser.browserOutput.bytes <= 32768,
  );
  const combinations = new Set();
  assert.equal(browser.results.length, 4);
  for (const result of browser.results) {
    assert.ok(["installed", "restored"].includes(result.lane));
    assert.ok(["v08", "v09"].includes(result.version));
    const combination = `${result.lane}/${result.version}`;
    assert.equal(combinations.has(combination), false);
    combinations.add(combination);
    assert.equal(result.status, "passed");
    assert.equal(result.bundleSha256, canvas.artifactHashes.bundles[result.version].sha256);
    assert.equal(result.tests.length, result.version === "v08" ? 4 : 6);
  }
  const owner = await read("canvas-browser/owner.json");
  assert.equal(browser.workerContainment.nonce, owner.nonce);
  assert.match(owner.nonce, /^[a-f0-9-]{36}$/);
  const contained = browser.containment;
  assert.equal(contained.verified, true);
  assert.match(contained.unit, /^openclaw-check-[a-f0-9-]+\.scope$/);
  verifyKernelReceipts(
    browser.workerContainment.before,
    browser.workerContainment.after,
    contained.unit,
  );
  assert.equal(contained.memoryLimitBytes, LIMIT);
  assert.equal(contained.memorySwapMax, 0);
  assert.equal(contained.nodeV8MiB, 512);
  assert.equal(contained.outerWallLimitMs, 60000);
  assert.equal(contained.workerTimeoutMs, WORKER_TIMEOUT_MS);
  assert.ok(
    Number.isSafeInteger(contained.elapsedMs) &&
      contained.elapsedMs >= 0 &&
      contained.elapsedMs < 60000,
  );
  assert.equal(contained.peakBytes, browser.workerContainment.after.peak);
  for (const field of ["maxLimitEvents", "oomEvents", "oomKillEvents"]) {
    assert.equal(contained[field], 0);
  }
  assert.equal(contained.empty, true);
  const finalUnit = parseScopeState({
    status: contained.systemctlStatus,
    stdout: Object.entries(contained.finalUnitState)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  });
  assert.equal(contained.unitRemoved, finalUnit.LoadState === "not-found");
  if (!contained.unitRemoved) {
    assert.equal(finalUnit.ControlGroup, browser.workerContainment.before.cgroup);
  }
  assert.ok(browser.assertions.includes("owned-cgroup-limit-and-extinction-verified"));
  return {
    passed: true,
    canvasCaptureSha256: canvasHash,
    discordCaptureSha256: await hashFile("discord-capture.json"),
    sourceLockSha256: before.lockSha256,
    sourceContractSha256: before.contractSha256,
    installedAndRestoredNodeVersions: ["24.22.1", "24.22.0"],
    canvas: { runtimeCases, browserCases: browser.caseCounts, closureScope: canvas.closureScope },
    discord: {
      derivedProbes,
      packageFiles: 231,
      runtimeFiles: 227,
      formats: ["cjs", "esm"],
      productionAudit: audit.metadata.vulnerabilities,
    },
  };
}
