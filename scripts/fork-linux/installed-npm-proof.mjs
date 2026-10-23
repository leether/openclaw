// Offline package-manager compatibility, using only synthetic packages and state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const [packageRoot, runtime, root] = process.argv.slice(2).map((p) => path.resolve(p));
assert.ok(packageRoot && runtime && root);
assert.equal(process.env.QUALIFICATION_NETWORK_ISOLATED, "1");
await fs.mkdir(root);
const require = createRequire(path.join(packageRoot, "package.json"));
const npmRoot = path.dirname(require.resolve("npm/package.json"));
const npmCli = path.join(npmRoot, "bin/npm-cli.js");
const report = {
  node: process.version,
  syntheticOnly: true,
  passed: false,
  bundled: {},
  phases: [],
};
const env = {
  HOME: path.join(root, "home"),
  PATH: path.dirname(runtime) + ":/usr/bin:/bin",
  npm_config_cache: path.join(root, "cache"),
  npm_config_userconfig: path.join(root, "empty.npmrc"),
  npm_config_registry: "http://127.0.0.1:9",
  npm_config_offline: "true",
};
await fs.writeFile(env.npm_config_userconfig, "");
async function command(args, cwd = root) {
  const child = spawn(runtime, [npmCli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "",
    stderr = "",
    limited = false;
  const stop = () => {
    limited = true;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(stop, 25000);
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.length > 1024 * 1024) {
      stop();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 1024 * 1024) {
      stop();
    }
  });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(limited, false, "npm subprocess limit");
    assert.equal(code, 0, stderr.slice(-3000));
    return output;
  } finally {
    clearTimeout(timer);
  }
}
try {
  report.version = (await command(["--version"])).trim();
  assert.equal(report.version, "12.2.1");
  for (const [name, expected] of Object.entries({
    "brace-expansion": "5.0.12",
    "http-cache-semantics": "4.3.0",
    undici: "6.29.0",
  })) {
    const meta = JSON.parse(
      await fs.readFile(path.join(npmRoot, "node_modules", name, "package.json"), "utf8"),
    );
    assert.equal(meta.version, expected, name);
    report.bundled[name] = meta.version;
  }
  const archives = [];
  for (const version of ["1.0.0", "1.0.1"]) {
    const dir = path.join(root, "source-" + version);
    await fs.mkdir(dir);
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "synthetic-npm-qualification",
        version,
        scripts: {
          postinstall: "node -e \"require('fs').writeFileSync('script-ran','unexpected')\"",
        },
      }),
    );
    const packed = JSON.parse(await command(["pack", "--ignore-scripts", "--json"], dir));
    const archive = packed["synthetic-npm-qualification"];
    assert.equal(archive.version, version);
    assert.equal(archive.filename, `synthetic-npm-qualification-${version}.tgz`);
    archives.push(path.join(dir, archive.filename));
  }
  const target = path.join(root, "install");
  await fs.mkdir(target);
  await fs.writeFile(
    path.join(target, "package.json"),
    JSON.stringify({ name: "synthetic-consumer", private: true }),
  );
  for (const index of [0, 1, 0]) {
    await command([
      "install",
      "--prefix",
      target,
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      archives[index],
    ]);
    const installed = path.join(target, "node_modules/synthetic-npm-qualification");
    const meta = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
    assert.equal(meta.version, index === 0 ? "1.0.0" : "1.0.1");
    await assert.rejects(fs.lstat(path.join(installed, "script-ran")), { code: "ENOENT" });
    report.phases.push({ version: meta.version, installScriptSuppressed: true });
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify(report));
}
