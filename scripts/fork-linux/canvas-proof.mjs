// Synthetic qualification of canonical built and installed Canvas consumers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runManagedBrowser, runBrowserWorker } from "./canvas-managed.mjs";
import {
  BUNDLES,
  ENTRY,
  RUNTIME_CASE_COUNTS,
  sha,
  fileHash,
  ownedFile,
  bundleHashes,
  verifyFiles,
  exerciseCanvas,
} from "./canvas-runtime.mjs";

const base = (phase) => ({
  schemaVersion: 1,
  phase,
  passed: false,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
});
function rootPath(value) {
  assert.ok(value && path.isAbsolute(value), "Absolute root required");
  const root = fs.realpathSync(value);
  assert.ok(fs.statSync(root).isDirectory());
  assert.equal(
    JSON.parse(fs.readFileSync(ownedFile(root, "package.json"), "utf8")).name,
    "openclaw",
  );
  return root;
}
function captureFile(file) {
  assert.ok(path.isAbsolute(file));
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length < 4 * 1024 ** 2);
  const report = JSON.parse(bytes);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.phase, "capture");
  assert.equal(report.passed, true);
  assert.equal(report.platform, "linux");
  assert.equal(report.arch, "x64");
  assert.match(report.node, /^v24\.22\.[01]$/u);
  assert.deepEqual(report.caseCounts, RUNTIME_CASE_COUNTS);
  assert.deepEqual(
    report.patchedInputs.map((x) => [x.name, x.version, x.resolvedZodVersion]),
    [
      ["@a2ui/web_core", "0.11.0", "4.6.6"],
      ["@a2ui/lit", "0.11.0", "4.6.6"],
    ],
  );
  assert.ok(report.artifactHashes.runtimeClosure[ENTRY]);
  return { report, captureSha256: sha(bytes) };
}
function verifyCore(root, captured) {
  const bundles = bundleHashes(root);
  assert.deepEqual(
    bundles,
    captured.artifactHashes.bundles,
    "Installed browser bytes differ from captured build",
  );
  verifyFiles(root, captured.artifactHashes.runtimeClosure);
  return bundles;
}
async function capture(sourceRoot) {
  const root = rootPath(sourceRoot);
  assert.equal(
    ownedFile(root, "scripts/fork-linux/patched-consumer-contract.mjs"),
    fs.realpathSync(fileURLToPath(new URL("./patched-consumer-contract.mjs", import.meta.url))),
    "Capture verifier must belong to the selected source checkout",
  );
  const { verifySourceInputs } = await import("./patched-consumer-contract.mjs");
  const verified = verifySourceInputs(root);
  assert.equal(verified.passed, true);
  const patchedInputs = verified.packages.filter((x) => x.name.startsWith("@a2ui/"));
  assert.deepEqual(
    patchedInputs.map((x) => [x.name, x.version, x.resolvedZodVersion]),
    [
      ["@a2ui/web_core", "0.11.0", "4.6.6"],
      ["@a2ui/lit", "0.11.0", "4.6.6"],
    ],
  );
  const sources = [
    "package.json",
    "pnpm-lock.yaml",
    "patches/zod4-consumers.json",
    "scripts/fork-linux/patched-consumer-contract.mjs",
    "extensions/canvas/scripts/bundle-a2ui.mjs",
    "extensions/canvas/index.ts",
    "extensions/canvas/package.json",
    "extensions/canvas/src/a2ui-jsonl.ts",
    "extensions/canvas/src/board-widget.ts",
    "extensions/canvas/src/host/a2ui-app/bootstrap.js",
    "extensions/canvas/src/host/a2ui-app/bootstrap-v0.9.js",
    "extensions/canvas/src/host/a2ui-app/rolldown.config.mjs",
  ];
  const sourceInputs = Object.fromEntries(
    sources.map((name) => [name, fileHash(ownedFile(root, name))]),
  );
  const bundles = bundleHashes(root);
  const bundler = await import(
    pathToFileURL(ownedFile(root, "extensions/canvas/scripts/bundle-a2ui.mjs"))
  );
  const tracked = bundler.listTrackedInputFiles(spawnSync, root);
  assert.ok(tracked?.length, "Canonical bundle input discovery must succeed");
  const buildHash = createHash("sha256");
  for (const file of [...new Set(tracked)].toSorted(bundler.compareNormalizedPaths)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const bytes = fs.readFileSync(ownedFile(root, relative));
    assert.ok(bytes.length < 32 * 1024 ** 2);
    buildHash.update(relative);
    buildHash.update("\0");
    buildHash.update(bytes);
    buildHash.update("\0");
  }
  const bundleBuildInputHash = buildHash.digest("hex");
  const stamp = "extensions/canvas/src/host/a2ui/.bundle.hash";
  assert.equal(
    fs.readFileSync(ownedFile(root, stamp), "utf8").trim(),
    bundleBuildInputHash,
    "Canvas bundle stamp does not match canonical current build inputs",
  );
  sourceInputs[stamp] = fileHash(ownedFile(root, stamp));
  for (const value of Object.values(bundles)) {
    const sourceBundle = `extensions/canvas/src/host/a2ui/${path.basename(value.path)}`;
    assert.deepEqual(
      fileHash(ownedFile(root, sourceBundle)),
      { sha256: value.sha256, bytes: value.bytes },
      "Copied dist bundle must equal the stamped canonical source bundle",
    );
  }
  const exercised = await exerciseCanvas(root);
  return {
    ...base("capture"),
    passed: true,
    patchedInputs,
    artifactHashes: {
      sourceLock: verified.lockSha256,
      consumerContract: verified.contractSha256,
      sourceInputs,
      bundleBuildInputHash,
      bundles,
      runtimeClosure: exercised.runtimeClosure,
    },
    caseCounts: exercised.caseCounts,
    assertions: exercised.assertions,
    runtimeClosureBytes: exercised.closureBytes,
    externalModuleCount: exercised.externalModuleCount,
    closureScope: exercised.closureScope,
    limitations: [
      "Captures named actual loaded paths, not every lazy Canvas command.",
      "Source identity and normal resolver contract are bound; full build and final artifact lineage belong to CI.",
    ],
  };
}
async function runtime(installedRoot, capturePath) {
  const root = rootPath(installedRoot);
  const { report: captured, captureSha256 } = captureFile(capturePath);
  const bundles = verifyCore(root, captured);
  const exercised = await exerciseCanvas(root);
  assert.deepEqual(
    exercised.runtimeClosure,
    captured.artifactHashes.runtimeClosure,
    "Actual installed core closure differs from built consumer closure",
  );
  return {
    ...base("runtime"),
    passed: true,
    captureSha256,
    artifactHashes: { bundles, runtimeClosure: exercised.runtimeClosure },
    caseCounts: exercised.caseCounts,
    assertions: exercised.assertions,
    externalModuleCount: exercised.externalModuleCount,
    closureScope: exercised.closureScope,
    limitations: [
      "Uses actual installed registration/JSONL/composition; no Gateway or paired device.",
      "External production dependency graph and audit are separately verified by install qualification.",
    ],
  };
}
async function sandbox(_installed, _restored, source, _capture, proofDir) {
  const { runBrowserProof } = await import("./canvas-browser.mjs");
  const report = await runBrowserProof({
    root: proofDir,
    playwrightRoot: rootPath(source),
    bundles: {},
    captureSha256: null,
    sandboxOnly: true,
  });
  report.phase = "sandbox-prerequisite";
  report.assertions = [];
  return report;
}
async function browser(installedRoot, restoredRoot, playwrightRoot, capturePath, proofDir) {
  const installed = rootPath(installedRoot);
  const restored = rootPath(restoredRoot);
  assert.notEqual(installed, restored, "Restore must use an independent prefix");
  const source = rootPath(playwrightRoot);
  const { report: captured, captureSha256 } = captureFile(capturePath);
  const artifactHashes = {
    installed: verifyCore(installed, captured),
    restored: verifyCore(restored, captured),
  };
  assert.ok(path.isAbsolute(proofDir));
  const bundles = Object.fromEntries(
    [
      ["installed", installed],
      ["restored", restored],
    ].map(([lane, root]) => [
      lane,
      Object.fromEntries(
        Object.entries(BUNDLES).map(([version, name]) => [version, ownedFile(root, name)]),
      ),
    ]),
  );
  const { runBrowserProof } = await import("./canvas-browser.mjs");
  const result = await runBrowserProof({
    root: proofDir,
    playwrightRoot: source,
    bundles,
    captureSha256,
  });
  result.artifactHashes = artifactHashes;
  result.assertions = [];
  if (result.passed) {
    assert.deepEqual(result.caseCounts, { combinations: 4, passed: 4, steps: 20 });
    assert.equal(result.cleanup.cdpClosed, true);
    assert.equal(result.cleanup.serverClosed, true);
    assert.equal(result.cleanup.browserLeaderExited, true);
    for (const key of ["closeError", "error", "killError"]) {
      assert.equal(result.cleanup[key], undefined);
    }
    result.assertions = [
      "installed-v08-passed",
      "installed-v09-passed",
      "restored-v08-passed",
      "restored-v09-passed",
      "exact-captured-bundle-bytes",
      "all-contexts-closed",
      "browser-leader-and-pipes-closed",
      "loopback-server-closed",
    ];
  }
  return result;
}

async function main(args) {
  const [phase, ...values] = args;
  assert.ok(
    ["capture", "runtime", "browser", "sandbox", "__browser_worker", "__sandbox_worker"].includes(
      phase,
    ),
  );
  assert.equal(
    values.length,
    { capture: 2, runtime: 3, browser: 5, sandbox: 5, __browser_worker: 6, __sandbox_worker: 6 }[
      phase
    ],
  );
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.match(
    process.version,
    /^v24\.22\.[01]$/u,
    "Linux qualifier must use an exact approved Node 24 runtime",
  );
  if (phase === "browser" || phase === "sandbox") {
    return await runManagedBrowser(values, fileURLToPath(import.meta.url), phase);
  }
  if (phase === "__browser_worker" || phase === "__sandbox_worker") {
    return await runBrowserWorker(
      values.slice(0, 5),
      values[5],
      phase === "__browser_worker" ? browser : sandbox,
    );
  }
  const output = values.at(-1);
  assert.ok(path.isAbsolute(output) && !fs.existsSync(output), "New absolute output path required");
  let report;
  try {
    report = phase === "capture" ? await capture(values[0]) : await runtime(values[0], values[1]);
  } catch (error) {
    report = { ...base(phase), error: String(error.message).slice(0, 2000) };
  }
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main(process.argv.slice(2));
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        phase: result.phase,
        passed: result.passed,
        node: result.node,
        caseCounts: result.caseCounts,
        error: result.error,
      }),
    );
    if (!result.passed) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(String(error.message).slice(0, 2000));
    process.exitCode = 1;
  }
}
