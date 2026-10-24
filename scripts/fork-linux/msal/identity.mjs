import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
export const sha = (data) => createHash("sha256").update(data).digest("hex");
export const parents = [
  ["@azure/identity", "4.13.3", "dda9dbd4c4bcce4abf34b2a4a37a64b0e63cfc8c4322a30a263df6d99e5886df"],
  [
    "@microsoft/teams.apps",
    "2.1.0",
    "316649efd9dfd0e0c7193f8c128fd9a3a5c91503f340747754a9577e851728e2",
  ],
];
export const officialMsal = {
  version: "7.1.0",
  packageSha256: "9ed42c96a5813ffcb7a18ba5374a3cba7e37e791a738b9cff40b4d610122350b",
  entrySha256: "a84b873be7ef48521e3dd6336908812421414f6d4f977ee1c536dc69ea1302d8",
};
function packageFor(require, name, packageName = name) {
  const entry = fs.realpathSync(require.resolve(name));
  let dir = path.dirname(entry);
  for (let n = 0; n < 12; n++) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      const pkg = JSON.parse(bytes);
      if (pkg.name === packageName) {
        return {
          dir,
          entry,
          pkg,
          packageSha256: sha(bytes),
          entrySha256: sha(fs.readFileSync(entry)),
        };
      }
    }
    const next = path.dirname(dir);
    assert.notEqual(next, dir);
    dir = next;
  }
  throw new Error("package owner missing");
}
function inside(root, file) {
  const rel = path.relative(root, file);
  assert.ok(
    rel && !rel.startsWith("..") && !path.isAbsolute(rel),
    "resolved package outside declared installation",
  );
  return rel.split(path.sep).join("/");
}
export function inspectParentDependencyManifest(require, parent, expected, boundary) {
  // Azure's nearest entry package is dist/commonjs/package.json, which does not
  // own dependencies. Resolve the exported root manifest independently.
  const file = fs.realpathSync(require.resolve(`${expected.name}/package.json`));
  const dir = path.dirname(file);
  inside(boundary, dir);
  inside(dir, parent.entry);
  const bytes = fs.readFileSync(file);
  const pkg = JSON.parse(bytes);
  assert.equal(pkg.name, expected.name);
  assert.equal(pkg.version, expected.version);
  assert.equal(pkg.dependencies?.["@azure/msal-node"], officialMsal.version);
  const packageSha256 = sha(bytes);
  assert.equal(packageSha256, expected.packageSha256, "reviewed parent dependency manifest");
  const msal = packageFor(createRequire(parent.entry), "@azure/msal-node");
  const declaredMsal = packageFor(createRequire(file), "@azure/msal-node");
  assert.equal(msal.dir, declaredMsal.dir, "parent root and entry MSAL package identity");
  assert.equal(msal.entry, declaredMsal.entry, "parent root and entry MSAL entry identity");
  return {
    dependencyManifestRelative: inside(boundary, file),
    dependencyManifestSha256: packageSha256,
    declaredMsalRange: pkg.dependencies["@azure/msal-node"],
    msalResolutionContextsEqual: true,
    msal,
  };
}
export function inspect(packageRoot, boundaryRoot = packageRoot) {
  const root = fs.realpathSync(packageRoot),
    boundary = fs.realpathSync(boundaryRoot),
    req = createRequire(path.join(root, "package.json"));
  const plugin = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(plugin.name, "@openclaw/msteams");
  assert.equal(plugin.version, "2026.10.4");
  if (root !== boundary) {
    inside(boundary, root);
  }
  return parents.map(([name, version, dependencyManifestSha256]) => {
    const parent = packageFor(req, name);
    assert.equal(parent.pkg.version, version);
    inside(boundary, parent.dir);
    const { msal, ...dependencyManifest } = inspectParentDependencyManifest(
      req,
      parent,
      { name, version, packageSha256: dependencyManifestSha256 },
      boundary,
    );
    assert.equal(msal.pkg.version, officialMsal.version);
    inside(boundary, msal.dir);
    assert.equal(msal.packageSha256, officialMsal.packageSha256, "official MSAL manifest bytes");
    assert.equal(msal.entrySha256, officialMsal.entrySha256, "official MSAL CJS entry bytes");
    const common = packageFor(
      createRequire(path.join(msal.dir, "package.json")),
      "@azure/msal-common/node",
      "@azure/msal-common",
    );
    assert.equal(common.pkg.version, "16.14.2");
    inside(boundary, common.dir);
    return Object.assign(
      {
        name,
        version,
        parentRelative: inside(boundary, parent.dir),
        packageSha256: parent.packageSha256,
        entrySha256: parent.entrySha256,
      },
      dependencyManifest,
      {
        msal: {
          name: "@azure/msal-node",
          version: msal.pkg.version,
          relative: inside(boundary, msal.dir),
          packageSha256: msal.packageSha256,
          entrySha256: msal.entrySha256,
          commonVersion: common.pkg.version,
          commonPackageSha256: common.packageSha256,
        },
        parentRoot: parent.dir,
      },
    );
  });
}
export function identityOnly(rows) {
  return rows.map(({ parentRoot: _parentRoot, ...row }) => row);
}
export function hashesOnly(rows) {
  return rows.map(
    ({
      parentRoot: _parentRoot,
      parentRelative: _parentRelative,
      dependencyManifestRelative: _dependencyManifestRelative,
      msal,
      ...row
    }) => {
      const { relative: _relative, ...msalHashes } = msal;
      return { ...row, msal: msalHashes };
    },
  );
}
