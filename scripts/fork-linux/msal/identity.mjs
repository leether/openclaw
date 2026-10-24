import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
export const sha = (data) => createHash("sha256").update(data).digest("hex");
export const parents = [
  ["@azure/identity", "4.13.3"],
  ["@microsoft/teams.apps", "2.1.0"],
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
  return parents.map(([name, version]) => {
    const parent = packageFor(req, name);
    assert.equal(parent.pkg.version, version);
    inside(boundary, parent.dir);
    const msal = packageFor(
      createRequire(path.join(parent.dir, "package.json")),
      "@azure/msal-node",
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
    return {
      name,
      version,
      parentRelative: inside(boundary, parent.dir),
      packageSha256: parent.packageSha256,
      entrySha256: parent.entrySha256,
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
    };
  });
}
export function identityOnly(rows) {
  return rows.map(({ parentRoot: _parentRoot, ...row }) => row);
}
export function hashesOnly(rows) {
  return rows.map(({ parentRoot: _parentRoot, parentRelative: _parentRelative, msal, ...row }) => {
    const { relative: _relative, ...msalHashes } = msal;
    return { ...row, msal: msalHashes };
  });
}
