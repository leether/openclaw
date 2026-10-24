import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";

// npm rebuilds bundled dependency bins even with --ignore-scripts. These nine
// links are installation metadata, not extra files in the authenticated tarball.
export const NPM_BIN_LINK_CONTRACT = Object.freeze({
  version: "npm-installed-bin-links-v1",
  count: 9,
  sha256: "287ad4bb6dcdb709bf4c62fcf128a56b0746833be8980d3f85afa123bbaaa01a",
  links: Object.freeze(
    [
      { path: "node_modules/.bin/arborist", target: "../@npmcli/arborist/bin/index.js" },
      { path: "node_modules/.bin/cssesc", target: "../cssesc/bin/cssesc" },
      {
        path: "node_modules/.bin/installed-package-contents",
        target: "../@npmcli/installed-package-contents/bin/index.js",
      },
      { path: "node_modules/.bin/node-gyp", target: "../node-gyp/bin/node-gyp.js" },
      { path: "node_modules/.bin/node-which", target: "../which/bin/which.js" },
      { path: "node_modules/.bin/nopt", target: "../nopt/bin/nopt.js" },
      { path: "node_modules/.bin/pacote", target: "../pacote/bin/index.js" },
      {
        path: "node_modules/.bin/qrcode-terminal",
        target: "../qrcode-terminal/bin/qrcode-terminal.js",
      },
      { path: "node_modules/.bin/semver", target: "../semver/bin/semver.js" },
    ].map((entry) => Object.freeze(entry)),
  ),
});

// Callers pass files returned by the official/derived archive authenticator,
// never manifests read from the mutable installed package being checked.
export function deriveNpmBinLinkInventory(files) {
  const payload = new Map(files.map((file) => [file.path, file]));
  assert.equal(payload.size, files.length, "duplicate authenticated payload path");
  const links = new Map();
  for (const file of files) {
    if (!/^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)+package\.json$/.test(file.path)) {
      continue;
    }
    const manifest = JSON.parse(Buffer.from(file.content).toString("utf8"));
    if (manifest.bin === undefined) {
      continue;
    }
    const packageRoot = path.posix.dirname(file.path);
    const nestedName = packageRoot.split("/node_modules/").at(-1);
    assert.ok(nestedName);
    const packageName = nestedName.replace(/^node_modules\//, "");
    assert.equal(manifest.name, packageName, "bundled bin package identity mismatch");
    const defaultBinName = packageName.split("/").at(-1);
    assert.ok(defaultBinName);
    const bins =
      typeof manifest.bin === "string" ? { [defaultBinName]: manifest.bin } : manifest.bin;
    assert.ok(bins && typeof bins === "object" && !Array.isArray(bins), "invalid bundled bins");
    const entries = Object.entries(bins);
    assert.ok(entries.length <= 32, "bundled bin count bound");
    const nodeModules = packageRoot.slice(0, -(packageName.length + 1));
    for (const [name, target] of entries) {
      assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "invalid bundled bin name");
      assert.ok(typeof target === "string", "invalid bundled bin target");
      const relativeTarget = target.replace(/^\.\//, "");
      assert.ok(
        relativeTarget &&
          !relativeTarget.includes("\\") &&
          !relativeTarget.includes("\0") &&
          !relativeTarget.split("/").some((part) => !part || part === "." || part === ".."),
        "unsafe bundled bin target",
      );
      const targetPath = `${packageRoot}/${relativeTarget}`;
      assert.ok(payload.has(targetPath), "bundled bin target missing from authenticated payload");
      const linkPath = `${nodeModules}/.bin/${name}`;
      assert.ok(!payload.has(linkPath) && !links.has(linkPath), "conflicting bundled bin path");
      links.set(linkPath, {
        path: linkPath,
        target: path.posix.relative(path.posix.dirname(linkPath), targetPath),
      });
    }
  }
  const ordered = [...links.values()].toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    version: NPM_BIN_LINK_CONTRACT.version,
    count: ordered.length,
    sha256: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
    links: ordered,
  };
}
