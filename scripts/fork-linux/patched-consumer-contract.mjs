// Verify the actual pnpm source inputs before and after the canonical build.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function packageRootForEntry(entry, name) {
  let root = path.dirname(fs.realpathSync(entry));
  for (let depth = 0; depth < 8; depth++) {
    const manifest = path.join(root, "package.json");
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === name) {
      return root;
    }
    root = path.dirname(root);
  }
  throw new Error(`Could not bind the actual entry to ${name}`);
}

export function verifyPackageTree(packageRoot, expected) {
  const rows = [];
  let bytes = 0;
  let entries = 0;
  const visit = (relative) => {
    assert.ok(relative.split("/").length <= 32, "Package directory depth limit");
    for (const entry of fs.readdirSync(path.join(packageRoot, relative), { withFileTypes: true })) {
      assert.ok(++entries <= 4096, "Package entry count limit");
      // Package-manager dependency links and .bin shims are installation
      // metadata. This inventory binds published package files only; each
      // installed dependency graph is separately captured and audited.
      if (relative === "" && entry.name === "node_modules") {
        continue;
      }
      const name = path.posix.join(relative, entry.name);
      const file = path.join(packageRoot, name);
      assert.ok(!entry.isSymbolicLink(), `Unexpected package symlink: ${name}`);
      if (entry.isDirectory()) {
        visit(name);
        continue;
      }
      assert.ok(entry.isFile(), `Unexpected package entry: ${name}`);
      const stat = fs.statSync(file);
      bytes += stat.size;
      assert.ok(stat.size <= 8 * 1024 ** 2 && bytes <= 32 * 1024 ** 2);
      assert.ok(rows.length < 2048);
      rows.push([
        name,
        sha(fs.readFileSync(file)),
        stat.size,
        `0o${(stat.mode & 0o777).toString(8)}`,
      ]);
    }
  };
  visit("");
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  assert.equal(rows.length, expected.fileCount);
  const rawTreeSha256 = sha(JSON.stringify(rows));
  const manifest = rows.find((row) => row[0] === "package.json");
  assert.ok(manifest);
  assert.ok(
    expected.packageJsonVariants.some(
      (variant) =>
        manifest[1] === variant.sha256 &&
        manifest[2] === variant.bytes &&
        manifest[3] === variant.mode,
    ),
    "Unreviewed package.json bytes",
  );
  const canonical = expected.packageJsonVariants[0];
  const normalized = rows.map((row) =>
    row[0] === "package.json" ? [row[0], canonical.sha256, canonical.bytes, canonical.mode] : row,
  );
  assert.equal(sha(JSON.stringify(normalized)), expected.targetTreeSha256);
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, expected.name);
  assert.equal(pkg.version, expected.version);
  assert.equal(pkg.dependencies.zod, "4.6.6");
  if (pkg.name === "@a2ui/web_core") {
    assert.equal(pkg.dependencies["zod-to-json-schema"], undefined);
  }
  return {
    name: pkg.name,
    version: pkg.version,
    files: rows.length,
    rawTreeSha256,
    excludedInstallationMetadata: ["node_modules"],
    targetTreeSha256: expected.targetTreeSha256,
    packageJsonSha256: manifest[1],
  };
}

export function verifySourceInputs(root) {
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, "patches/zod4-consumers.json"), "utf8"),
  );
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.treeSchema, "sorted-path-sha256-bytes-mode-array-v1");
  assert.equal(contract.packages.length, 3);
  const locks = YAML.parseAllDocuments(fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  for (const document of locks) {
    assert.equal(document.errors.length, 0);
  }
  const lock = locks.at(-1).toJSON();
  assert.equal(
    Object.keys(lock.packages).some((name) => name.startsWith("zod@3.")),
    false,
  );
  const packages = contract.packages.map((expected) => {
    const key = `${expected.name}@${expected.version}`;
    assert.equal(lock.packages[key].resolution.integrity, expected.officialIntegrity);
    assert.equal(lock.patchedDependencies[key], expected.patchSha256);
    for (const [file, hash] of [
      [expected.patch, expected.patchSha256],
      [expected.sourcePatch, expected.sourcePatchSha256],
    ]) {
      assert.equal(sha(fs.readFileSync(path.join(root, file))), hash);
    }
    const consumer = expected.name.startsWith("@a2ui/") ? "canvas" : "discord";
    const resolve = createRequire(path.join(root, `extensions/${consumer}/package.json`));
    const packageRoot = packageRootForEntry(resolve.resolve(expected.name), expected.name);
    const report = verifyPackageTree(packageRoot, expected);
    const localResolve = createRequire(path.join(packageRoot, "package.json"));
    const zodBytes = fs.readFileSync(localResolve.resolve("zod/package.json"));
    const zod = JSON.parse(zodBytes.toString("utf8"));
    assert.equal(zod.name, "zod");
    assert.equal(zod.version, "4.6.6");
    report.resolvedZodVersion = zod.version;
    report.resolvedZodPackageSha256 = sha(zodBytes);
    return report;
  });
  return {
    passed: true,
    node: process.version,
    packages,
    lockSha256: sha(fs.readFileSync(path.join(root, "pnpm-lock.yaml"))),
    contractSha256: sha(fs.readFileSync(path.join(root, "patches/zod4-consumers.json"))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, output] = process.argv.slice(2);
  assert.ok(root && output && path.isAbsolute(root) && path.isAbsolute(output));
  fs.writeFileSync(output, `${JSON.stringify(verifySourceInputs(root), null, 2)}\n`, {
    flag: "wx",
  });
}
