import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readDerivedProbeIdentity } from "../../scripts/fork-linux/discord/contracts.mjs";
import { collectConsumerQualification } from "../../scripts/fork-linux/zod-consumer-manifest.mjs";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const runtimeCases = { registration: 2, jsonlAccepted: 2, jsonlRejected: 9, composition: 2 };

function fixture() {
  const packages = ["@a2ui/web_core", "@a2ui/lit", "@discord/embedded-app-sdk"].map(
    (name, index) => ({
      name,
      version: index === 2 ? "2.5.0" : "0.11.0",
      fileCount: [671, 234, 231][index],
      targetTreeSha256: sha(name),
      patchSha256: sha(`${name}-patch`),
      sourcePatchSha256: sha(`${name}-source`),
    }),
  );
  const source = {
    passed: true,
    lockSha256: sha("lock"),
    contractSha256: sha("contract"),
    packages: packages.map((item) => ({
      name: item.name,
      version: item.version,
      files: item.fileCount,
      targetTreeSha256: item.targetTreeSha256,
      resolvedZodVersion: "4.6.6",
      resolvedZodPackageSha256: sha("zod-package"),
      excludedInstallationMetadata: ["node_modules"],
    })),
  };
  const canvas = {
    passed: true,
    platform: "linux",
    arch: "x64",
    node: "v24.22.1",
    schemaVersion: 1,
    phase: "capture",
    patchedInputs: source.packages.slice(0, 2),
    caseCounts: runtimeCases,
    assertions: ["synthetic-register"],
    artifactHashes: {
      sourceLock: source.lockSha256,
      consumerContract: source.contractSha256,
      bundles: { v08: { sha256: sha("v08") }, v09: { sha256: sha("v09") } },
      runtimeClosure: { "dist/canvas.js": { sha256: sha("runtime") } },
    },
  };
  const sdk = packages[2];
  assert.ok(sdk);
  const discord = {
    schema: "discord-installed-contract-v1",
    plugin: { name: "@openclaw/discord", version: "2026.10.4" },
    sdk: { name: sdk.name, version: "2.5.0", zod: "4.6.6", zodPackageSha256: sha("zod-package") },
    sdkTree: { targetTreeSha256: sdk.targetTreeSha256 },
    sourceProvenance: { patchSha256: sdk.patchSha256, sourcePatchSha256: sdk.sourcePatchSha256 },
    derivedProbes: readDerivedProbeIdentity(),
    assets: [{ installedPath: "dist/assets/embedded-app-sdk.mjs", sha256: sha("asset") }],
  };
  const audit = { metadata: { vulnerabilities: { high: 0, critical: 0 } } };
  const records = new Map<string, object>([
    ["patched-source-inputs-before.json", source],
    ["patched-source-inputs-after.json", structuredClone(source)],
    ["canvas-capture.json", canvas],
    ["discord-capture.json", discord],
    ["discord-installed-npm-audit.json", audit],
  ]);
  const child = () => ({
    passed: true,
    exitCode: 0,
    signal: null,
    failure: null,
    closed: true,
    elapsedMs: 5,
    outputBytes: 100,
  });
  const publicSdk = (format: string, kind = "package") => ({
    handshake: true,
    ready: true,
    exactNonceSettlement: true,
    foreignOriginIgnored: true,
    malformedResponseRemainsPending: true,
    duplicateResponseNoSecondSettlement: true,
    errorRejected: true,
    fallbackPreserved: true,
    threeCommandsNoRetries: true,
    noExternalIO: true,
    pendingCommandsAfterTerminal: 0,
    listenersAfterClose: 0,
    commands: 3,
    entry: {
      format,
      kind,
      resolver: format === "mjs" ? "node-esm-import-conditions" : "node-require",
      relative: `output/index.${format}`,
    },
  });
  const runtimes = [];
  const sdkReports = [];
  for (const version of ["24.22.1", "24.22.0"])
    for (const prefix of ["installed", "restored"]) {
      const runtime = {
        passed: true,
        platform: "linux",
        arch: "x64",
        node: `v${version}`,
        phase: "runtime",
        captureSha256: sha("capture"),
        caseCounts: { ...runtimeCases },
        assertions: [...canvas.assertions],
        artifactHashes: {
          bundles: canvas.artifactHashes.bundles,
          runtimeClosure: canvas.artifactHashes.runtimeClosure,
        },
      };
      const formats = Object.fromEntries(
        ["cjs", "esm"].map((format) => [
          format,
          {
            compatChecks: 86,
            generatedCommands: 13,
            errorCases: 19,
            nativePlainErrorFallback: {
              nativeSendCommand: true,
              plainErrorRejected: true,
              compatibilityFallback: true,
              primaryAndFallbackArgsExact: true,
              distinctNonces: true,
              commandFrames: 2,
              nativeRejections: 1,
              pendingCommandsAfterTerminal: 0,
              listenersAfterClose: 0,
            },
            threeElementsMaxOne: { rejected: true, elementVisits: 0 },
            publicSDK: publicSdk(format === "esm" ? "mjs" : format),
            children: { compat: child(), errors: child(), publicSDK: child() },
          },
        ]),
      );
      const report = {
        passed: true,
        platform: "linux",
        arch: "x64",
        node: `v${version}`,
        schema: "discord-installed-proof-v1",
        identity: {
          pluginName: discord.plugin.name,
          pluginVersion: discord.plugin.version,
          sdkName: sdk.name,
          sdkVersion: "2.5.0",
          packageFiles: 231,
          runtimeFiles: 227,
          resolvedZodVersion: "4.6.6",
          zodPackageRelative: "node_modules/zod/package.json",
          cjsEntryRelative: "output/index.cjs",
          esmEntryRelative: "output/index.mjs",
        },
        artifactHashes: {
          derivedProbes: structuredClone(discord.derivedProbes),
          expectedContract: sha(JSON.stringify(discord)),
          sdkCarrierTree: sdk.targetTreeSha256,
          resolvedZodPackage: sha("zod-package"),
          staticAssets: { "dist/assets/embedded-app-sdk.mjs": sha("asset") },
        },
        formats,
        assets: { generatedSdk: { ...child(), proof: publicSdk("mjs", "asset") } },
      };
      records.set(`${prefix}-canvas-proof-${version}.json`, runtime);
      records.set(`${prefix}-discord-proof-${version}.json`, report);
      runtimes.push(runtime);
      sdkReports.push(report);
    }
  const browser = {
    passed: true,
    platform: "linux",
    arch: "x64",
    node: "v24.22.1",
    phase: "browser",
    captureSha256: sha("capture"),
    caseCounts: { combinations: 4, passed: 4, steps: 20 },
    artifactHashes: {
      installed: canvas.artifactHashes.bundles,
      restored: canvas.artifactHashes.bundles,
    },
    cleanup: {
      browserLeaderExited: true,
      cdpClosed: true,
      serverClosed: true,
      processTreeVerifiedEmpty: true,
      requiresOuterProcessTreeVerification: false,
      closeError: undefined as string | undefined,
    },
    externalRequestsBlocked: [],
    webSocketsBlocked: [],
    pageErrors: [],
    requests: Array.from({ length: 12 }, () => ({ method: "GET" })),
    browserOutput: { bytes: 0, limitBytes: 32768, limitExceeded: false },
    results: ["installed", "restored"].flatMap((lane) =>
      ["v08", "v09"].map((version) => ({
        lane,
        version,
        status: "passed",
        bundleSha256: sha(version),
        tests: Array.from({ length: version === "v08" ? 4 : 6 }, (_, index) => `step-${index}`),
      })),
    ),
    workerContainment: {
      nonce: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      before: {
        cgroup: "/user.slice/openclaw-check-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.scope",
        device: "31",
        inode: "44",
        max: String(1024 ** 3),
        swapMax: "0",
        events: { max: 0, oom: 0, oom_kill: 0 },
        peak: 128,
      },
      after: {
        cgroup: "/user.slice/openclaw-check-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.scope",
        device: "31",
        inode: "44",
        max: String(1024 ** 3),
        swapMax: "0",
        events: { max: 0, oom: 0, oom_kill: 0 },
        peak: 256,
      },
    },
    containment: {
      verified: true,
      unit: "openclaw-check-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.scope",
      memoryLimitBytes: 1024 ** 3,
      memorySwapMax: 0,
      nodeV8MiB: 512,
      outerWallLimitMs: 60000,
      workerTimeoutMs: 20000,
      elapsedMs: 2000,
      peakBytes: 256,
      maxLimitEvents: 0,
      oomEvents: 0,
      oomKillEvents: 0,
      empty: true,
      unitRemoved: true,
      systemctlStatus: 0,
      finalUnitState: { LoadState: "not-found", ActiveState: "inactive", ControlGroup: "" },
    },
    assertions: ["owned-cgroup-limit-and-extinction-verified"],
  };
  records.set("canvas-browser/report.json", browser);
  records.set("canvas-browser/owner.json", { nonce: browser.workerContainment.nonce });
  const run = () =>
    collectConsumerQualification(
      async (name: string) => records.get(name),
      async (name: string) =>
        name === "source-pnpm-lock.yaml"
          ? sha("lock")
          : name === "canvas-capture.json"
            ? sha("capture")
            : sha(name),
      { packages },
      sha("contract"),
    );
  return { records, runtimes, sdkReports, discord, audit, browser, run };
}

describe("installed migration evidence aggregation", () => {
  it("accepts all four separate runtime paths with exact capture and output identity", async () => {
    await expect(fixture().run()).resolves.toMatchObject({ passed: true });
  });
  it.each(
    ["24.22.1", "24.22.0"].flatMap((version) =>
      ["installed", "restored"].flatMap((prefix) =>
        ["missing", "wrong-provenance", "old-probe"].map((fault) => ({
          name: `${prefix}-discord-proof-${version}.json`,
          fault,
        })),
      ),
    ),
  )("rejects $fault probe identity in $name", async ({ name, fault }) => {
    const f = fixture();
    const report = f.sdkReports.find((entry) => f.records.get(name) === entry);
    assert.ok(report);
    if (fault === "missing") {
      Reflect.deleteProperty(report.artifactHashes, "derivedProbes");
    } else if (fault === "wrong-provenance") {
      report.artifactHashes.derivedProbes.provenanceSha256 = sha("unreviewed-provenance");
    } else {
      report.artifactHashes.derivedProbes.probes["compat.mjs"] =
        "b63d4c06eb2a12ff7c37c53f3cc87cf5478c7a1dd0ec6240ab36aa7ff902196d";
    }
    await expect(f.run()).rejects.toThrow();
  });
  it.each(["missing", "wrong-provenance", "old-probe", "extra-probe"])(
    "rejects self-consistent capture and four reports with %s source proof",
    async (fault) => {
      const f = fixture();
      if (fault === "missing") {
        Reflect.deleteProperty(f.discord, "derivedProbes");
      } else if (fault === "wrong-provenance") {
        f.discord.derivedProbes.provenanceSha256 = sha("unreviewed-provenance");
      } else if (fault === "old-probe") {
        f.discord.derivedProbes.probes["compat.mjs"] =
          "b63d4c06eb2a12ff7c37c53f3cc87cf5478c7a1dd0ec6240ab36aa7ff902196d";
      } else {
        f.discord.derivedProbes.probes["unreviewed.mjs"] = sha("extra");
      }
      for (const report of f.sdkReports) {
        report.artifactHashes.derivedProbes = structuredClone(f.discord.derivedProbes);
        report.artifactHashes.expectedContract = sha(JSON.stringify(f.discord));
      }
      await expect(f.run()).rejects.toThrow();
    },
  );
  it.each(["missing", "not-plain", "unsettled", "extra-command"])(
    "rejects %s native plain-error fallback proof",
    async (fault) => {
      const f = fixture();
      const format = f.sdkReports[3]?.formats.esm;
      assert.ok(format);
      if (fault === "missing") {
        Reflect.deleteProperty(format, "nativePlainErrorFallback");
      } else if (fault === "not-plain") {
        format.nativePlainErrorFallback.plainErrorRejected = false;
      } else if (fault === "unsettled") {
        format.nativePlainErrorFallback.pendingCommandsAfterTerminal = 1;
      } else {
        format.nativePlainErrorFallback.commandFrames = 3;
      }
      await expect(f.run()).rejects.toThrow();
    },
  );
  it.each([
    "missing",
    "stale-capture",
    "unjoined-child",
    "old-parser",
    "high-audit",
    "wrong-browser",
    "changed-restored-bytes",
    "changed-zod-version",
    "changed-zod-bytes",
    "escaping-zod-path",
    "different-restored-zod-path",
    "repeated-browser-combination",
    "wrong-browser-bundle",
    "missing-browser-steps",
    "browser-cdp-open",
    "browser-cleanup-error",
    "browser-output-cap",
    "browser-cgroup-drift",
    "browser-swap",
    "browser-budget",
    "browser-unjoined",
    "browser-limit-hit",
    "browser-active-unit",
    "browser-owner-mismatch",
  ])("rejects %s evidence", async (fault) => {
    const f = fixture();
    const runtime = f.runtimes[3];
    const sdk = f.sdkReports[3];
    assert.ok(runtime && sdk && sdk.formats.esm);
    const esm = sdk.formats.esm;
    if (fault === "missing") f.records.delete("restored-discord-proof-24.22.0.json");
    if (fault === "stale-capture") runtime.captureSha256 = sha("old");
    if (fault === "unjoined-child") esm.children.publicSDK.closed = false;
    if (fault === "old-parser") esm.threeElementsMaxOne.elementVisits = 3;
    if (fault === "high-audit") f.audit.metadata.vulnerabilities.high = 1;
    if (fault === "wrong-browser") f.browser.caseCounts.passed = 3;
    if (fault === "changed-restored-bytes") sdk.artifactHashes.sdkCarrierTree = sha("old");
    if (fault === "changed-zod-version") sdk.identity.resolvedZodVersion = "3.25.76";
    if (fault === "changed-zod-bytes") sdk.artifactHashes.resolvedZodPackage = sha("changed");
    if (fault === "escaping-zod-path") sdk.identity.zodPackageRelative = "../zod/package.json";
    if (fault === "different-restored-zod-path")
      sdk.identity.zodPackageRelative = "node_modules/other/node_modules/zod/package.json";
    const browser = f.browser;
    const row = browser.results[3];
    assert.ok(row);
    if (fault === "repeated-browser-combination") row.version = "v08";
    if (fault === "wrong-browser-bundle") row.bundleSha256 = sha("wrong");
    if (fault === "missing-browser-steps") row.tests.pop();
    if (fault === "browser-cdp-open") browser.cleanup.cdpClosed = false;
    if (fault === "browser-cleanup-error") browser.cleanup.closeError = "failed";
    if (fault === "browser-output-cap") browser.browserOutput.limitExceeded = true;
    if (fault === "browser-cgroup-drift") browser.workerContainment.after.inode = "changed";
    if (fault === "browser-swap") browser.containment.memorySwapMax = 1;
    if (fault === "browser-budget") browser.containment.elapsedMs = 60000;
    if (fault === "browser-unjoined") browser.containment.empty = false;
    if (fault === "browser-limit-hit") browser.workerContainment.after.events.max = 1;
    if (fault === "browser-active-unit") browser.containment.finalUnitState.ActiveState = "active";
    if (fault === "browser-owner-mismatch")
      browser.workerContainment.nonce = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await expect(f.run()).rejects.toThrow();
  });
});
