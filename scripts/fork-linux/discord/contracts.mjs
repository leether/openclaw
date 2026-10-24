import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { verifyPackageTree } from "../patched-consumer-contract.mjs";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MANIFEST_SHA = "0a55a1dd6a42524cc3d512aa66dd4722aae436056b91fa167a78e0aefeb984f1";
const manifestBytes = fs.readFileSync(new URL("./frozen/target-manifest.json", import.meta.url));
assert.equal(sha(manifestBytes), MANIFEST_SHA, "frozen SDK manifest identity");
const sdkManifest = JSON.parse(manifestBytes);
assert.equal(Object.keys(sdkManifest).length, 231);
assert.equal(Object.keys(sdkManifest).filter((name) => name.startsWith("output/")).length, 227);
const SDK_TREE = {
  name: "@discord/embedded-app-sdk",
  version: "2.5.0",
  fileCount: 231,
  targetTreeSha256: "a23dd2f11ed0baf71e60f4f9cd1c04e2fc920b57898fa12cc729fe4b8364e432",
  packageJsonVariants: [
    {
      sha256: "79993c4cda5a6de1ac654029c3c7a43712c5b309802d6e3068523f371389e839",
      bytes: 2689,
      mode: "0o644",
    },
  ],
};

function relativeFile(value) {
  assert.equal(typeof value, "string");
  const normalized = value.replace(/^\.\//, "");
  assert.ok(normalized.length > 0 && normalized.length < 512 && !path.isAbsolute(normalized));
  assert.ok(!normalized.includes("\\") && !normalized.includes("\0"));
  assert.ok(normalized.split("/").every((part) => part && part !== "." && part !== ".."));
  return normalized;
}

function within(root, file) {
  const relative = path.relative(root, file);
  assert.ok(
    relative &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative),
    "physical path must belong to plugin package",
  );
  return relative.split(path.sep).join("/");
}

function readOwnFile(root, name, maxBytes = 16 * 1024 * 1024) {
  const rel = relativeFile(name);
  let current = root;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    assert.ok(!fs.lstatSync(current).isSymbolicLink(), "package file may not traverse symlinks");
  }
  const stat = fs.statSync(current);
  assert.ok(stat.isFile() && stat.size <= maxBytes, "bounded regular package file required");
  within(root, fs.realpathSync(current));
  return fs.readFileSync(current);
}

const PROBE_PROVENANCE_SHA = "c13e125b8ea2f9c4fd41a00fe13c57a42c3d4d962242440f9957c27e7cbd8ddd";

export function readDerivedProbeIdentity() {
  const root = path.join(import.meta.dirname, "frozen");
  const bytes = readOwnFile(root, "probe-provenance.json", 16384);
  assert.equal(sha(bytes), PROBE_PROVENANCE_SHA, "reviewed derived probe provenance identity");
  const provenance = JSON.parse(bytes);
  assert.equal(provenance.schema, "discord-derived-probes-v1");
  assert.deepEqual(
    provenance.files.map((file) => file.path),
    ["compat.mjs", "error-contract.mjs"],
  );
  const probes = {};
  for (const file of provenance.files) {
    const actual = readOwnFile(root, file.path, 65536);
    assert.equal(actual.length, file.bytes, "derived probe bytes");
    assert.equal(sha(actual), file.sha256, "derived probe identity");
    probes[file.path] = file.sha256;
  }
  return { provenanceSha256: sha(bytes), probes };
}

export function captureContract(sourceRoot) {
  const source = fs.realpathSync(sourceRoot);
  const dir = path.join(source, "extensions/discord");
  const sourceContract = JSON.parse(readOwnFile(source, "patches/zod4-consumers.json"));
  assert.equal(sourceContract.schemaVersion, 1);
  const expectedSdk = sourceContract.packages.find((item) => item.name === SDK_TREE.name);
  assert.ok(expectedSdk);
  for (const key of Object.keys(SDK_TREE)) {
    assert.deepEqual(expectedSdk[key], SDK_TREE[key]);
  }
  assert.equal(sha(readOwnFile(source, expectedSdk.patch)), expectedSdk.patchSha256);
  assert.equal(sha(readOwnFile(source, expectedSdk.sourcePatch)), expectedSdk.sourcePatchSha256);
  const pkg = JSON.parse(readOwnFile(dir, "package.json"));
  const manifest = JSON.parse(readOwnFile(dir, "openclaw.plugin.json"));
  assert.equal(pkg.name, "@openclaw/discord");
  assert.equal(pkg.dependencies["@discord/embedded-app-sdk"], "2.5.0");
  const sourceRequire = createRequire(path.join(dir, "package.json"));
  const sourceSdk = fs.realpathSync(sourceRequire.resolve(`${expectedSdk.name}/package.json`));
  within(source, sourceSdk);
  const sourceZod = fs.realpathSync(createRequire(sourceSdk).resolve("zod/package.json"));
  within(source, sourceZod);
  const sourceZodBytes = readOwnFile(path.dirname(sourceZod), "package.json");
  const sourceZodPackage = JSON.parse(sourceZodBytes);
  assert.equal(sourceZodPackage.name, "zod");
  assert.equal(sourceZodPackage.version, "4.6.6");
  assert.equal(manifest.id, "discord");
  const assets = [];
  for (const item of pkg.openclaw.build.staticAssets) {
    const assetSource = relativeFile(item.source);
    const installedPath = `dist/${relativeFile(item.output)}`;
    const bytes = readOwnFile(dir, assetSource);
    assets.push({
      kind: "static",
      source: assetSource,
      installedPath,
      bytes: bytes.length,
      sha256: sha(bytes),
    });
  }
  const ui = manifest.controlUi;
  assert.ok(ui && typeof ui.entry === "string");
  for (const uiSource of [ui.entry, ...(ui.styles ?? [])]) {
    const installedPath = relativeFile(uiSource);
    assert.match(installedPath, /^dist\/control-ui\/[a-f0-9]{64}\/index\.(?:js|css)$/);
    const bytes = readOwnFile(dir, installedPath);
    assets.push({
      kind: "control-ui",
      source: installedPath,
      installedPath,
      bytes: bytes.length,
      sha256: sha(bytes),
    });
  }
  const contract = {
    schema: "discord-installed-contract-v1",
    plugin: { name: pkg.name, version: pkg.version },
    sdk: {
      name: "@discord/embedded-app-sdk",
      version: "2.5.0",
      zod: "4.6.6",
      zodPackageSha256: sha(sourceZodBytes),
      manifestSha256: MANIFEST_SHA,
      packageFiles: 231,
      runtimeFiles: 227,
    },
    sdkTree: SDK_TREE,
    sourceProvenance: {
      patchSha256: expectedSdk.patchSha256,
      sourcePatchSha256: expectedSdk.sourcePatchSha256,
    },
    derivedProbes: readDerivedProbeIdentity(),
    controlUi: ui,
    assets,
  };
  validateContract(contract);
  return contract;
}

export function validateContract(contract) {
  assert.equal(contract.schema, "discord-installed-contract-v1");
  assert.equal(contract.plugin.name, "@openclaw/discord");
  assert.ok(typeof contract.plugin.version === "string" && contract.plugin.version.length < 64);
  const { zodPackageSha256, ...sdkIdentity } = contract.sdk;
  assert.match(zodPackageSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(sdkIdentity, {
    name: "@discord/embedded-app-sdk",
    version: "2.5.0",
    zod: "4.6.6",
    manifestSha256: MANIFEST_SHA,
    packageFiles: 231,
    runtimeFiles: 227,
  });
  assert.deepEqual(contract.sdkTree, SDK_TREE);
  assert.deepEqual(contract.derivedProbes, readDerivedProbeIdentity());
  for (const value of Object.values(contract.sourceProvenance)) {
    assert.match(value, /^[a-f0-9]{64}$/);
  }
  assert.ok(
    Array.isArray(contract.assets) && contract.assets.length >= 2 && contract.assets.length <= 32,
  );
  const names = new Set();
  for (const item of contract.assets) {
    relativeFile(item.source);
    relativeFile(item.installedPath);
    assert.ok(["static", "control-ui"].includes(item.kind));
    assert.ok(!names.has(item.installedPath));
    names.add(item.installedPath);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= 16 * 1024 * 1024);
  }
  assert.ok(
    contract.assets.some(
      (item) =>
        item.source === "assets/embedded-app-sdk.mjs" &&
        item.installedPath === "dist/assets/embedded-app-sdk.mjs" &&
        item.kind === "static",
    ),
  );
  assert.ok(contract.controlUi && typeof contract.controlUi.entry === "string");
  for (const name of [contract.controlUi.entry, ...(contract.controlUi.styles ?? [])]) {
    relativeFile(name);
    assert.ok(
      contract.assets.some((item) => item.kind === "control-ui" && item.installedPath === name),
    );
  }
  return contract;
}

export function inspectInstallation(pluginRoot, contract) {
  validateContract(contract);
  const root = fs.realpathSync(pluginRoot);
  const plugin = JSON.parse(readOwnFile(root, "package.json"));
  assert.equal(plugin.name, contract.plugin.name);
  assert.equal(plugin.version, contract.plugin.version);
  const require = createRequire(path.join(root, "package.json"));
  const sdkRoot = path.dirname(
    fs.realpathSync(require.resolve(`${contract.sdk.name}/package.json`)),
  );
  const sdkRelative = within(root, sdkRoot);
  const pkg = JSON.parse(readOwnFile(sdkRoot, "package.json"));
  assert.equal(pkg.name, contract.sdk.name);
  assert.equal(pkg.version, contract.sdk.version);
  assert.equal(pkg.dependencies.zod, "4.6.6");
  const tree = verifyPackageTree(sdkRoot, contract.sdkTree);
  const sdkRequire = createRequire(path.join(sdkRoot, "package.json"));
  const zodPackagePath = fs.realpathSync(sdkRequire.resolve("zod/package.json"));
  const zodPackageRelative = within(root, zodPackagePath);
  const zodBytes = readOwnFile(path.dirname(zodPackagePath), "package.json");
  const zod = JSON.parse(zodBytes);
  assert.equal(zod.name, "zod");
  assert.equal(zod.version, "4.6.6");
  assert.equal(sha(zodBytes), contract.sdk.zodPackageSha256);
  const cjs = fs.realpathSync(require.resolve(contract.sdk.name));
  assert.equal(cjs, path.join(sdkRoot, "output/index.cjs"));
  const metadata = JSON.parse(readOwnFile(root, "openclaw.plugin.json"));
  assert.equal(metadata.id, "discord");
  assert.deepEqual(metadata.controlUi, contract.controlUi);
  const assetHashes = {};
  for (const item of contract.assets) {
    const bytes = readOwnFile(root, item.installedPath);
    assert.equal(bytes.length, item.bytes, "generated asset bytes");
    assert.equal(sha(bytes), item.sha256, "generated asset hash");
    assetHashes[item.installedPath] = item.sha256;
  }
  return {
    root,
    sdkRoot,
    identity: {
      pluginName: plugin.name,
      pluginVersion: plugin.version,
      sdkName: pkg.name,
      sdkVersion: pkg.version,
      sdkRelative,
      packageFiles: tree.files,
      runtimeFiles: 227,
      resolvedZodVersion: zod.version,
      zodPackageRelative,
      dependencySpace: {
        path: `${sdkRelative}/node_modules`,
        excludedFromCarrierSet: true,
        exists: fs.existsSync(path.join(sdkRoot, "node_modules")),
        graphQualificationByCaller: true,
      },
      cjsEntryRelative: within(root, cjs),
    },
    artifactHashes: {
      derivedProbes: readDerivedProbeIdentity(),
      manifest: MANIFEST_SHA,
      sdkCarrierTree: tree.rawTreeSha256,
      sdkPackage: sdkManifest["package.json"].sha256,
      resolvedZodPackage: sha(zodBytes),
      cjsEntry: sdkManifest["output/index.cjs"].sha256,
      esmEntry: sdkManifest["output/index.mjs"].sha256,
      staticAssets: assetHashes,
    },
  };
}
