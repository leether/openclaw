// Real installed npm consumers with synthetic package/header fixtures only.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  authenticateCarrierInputs,
  runCarrierRoundtrip,
  verifyMainNpmPayload,
} from "./npm/carrier-roundtrip.mjs";
import {
  assertLinuxLoopbackNamespace,
  isolatedEnvironment,
  publicCommand,
  resolveConsumers,
  runConsumers,
} from "./npm/consumer-proof.mjs";
import { managedCommand } from "./npm/managed.mjs";

export function parseArguments(argv) {
  assert.ok(
    argv.length === 3 || argv.length === 7,
    "expected packageRoot runtime emptyStateRoot [--carrier-roundtrip officialNpm officialUndici derivedNpm]",
  );
  assert.ok(argv.every((value) => typeof value === "string" && value.length > 0));
  if (argv.length === 7) {
    assert.equal(argv[3], "--carrier-roundtrip");
  }
  return {
    packageRoot: path.resolve(argv[0]),
    runtime: path.resolve(argv[1]),
    root: path.resolve(argv[2]),
    archives: argv.length === 7 ? argv.slice(4).map((p) => path.resolve(p)) : null,
  };
}

export async function runInstalledNpmProof({ packageRoot, runtime, root, archives }, report) {
  assert.equal(
    await fs.realpath(runtime),
    await fs.realpath(process.execPath),
    "runtime invocation mismatch",
  );
  report.network = await assertLinuxLoopbackNamespace();
  const env = await isolatedEnvironment(root, runtime);
  const consumers = await resolveConsumers(packageRoot);
  report.identity = consumers.identity;
  report.qualificationEligible = false;
  const verified = archives ? await authenticateCarrierInputs(archives) : null;
  if (verified) {
    report.mainInventory = await verifyMainNpmPayload(consumers.npmRoot, verified);
    report.mainAuthentication = { ...verified.authentication, beforeFirstCommand: true };
    report.qualificationEligible = true;
  }
  report.commands = [];
  async function command(args, cwd = root) {
    const receipt = await managedCommand({ runtime, args: [consumers.npmCli, ...args], cwd, env });
    report.commands.push(publicCommand(receipt));
    assert.equal(receipt.status, 0, "synthetic npm command failed");
    return receipt.stdout;
  }
  report.version = (await command(["--version"])).trim();
  assert.equal(report.version, "12.2.1");
  report.bundled = {};
  for (const [name, expected] of Object.entries({
    "brace-expansion": "5.0.12",
    "http-cache-semantics": "4.3.0",
    undici: "6.29.1",
  })) {
    const meta = JSON.parse(
      await fs.readFile(path.join(consumers.npmRoot, "node_modules", name, "package.json"), "utf8"),
    );
    assert.equal(meta.version, expected, name);
    report.bundled[name] = meta.version;
  }
  const syntheticArchives = [];
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
      { flag: "wx" },
    );
    const packed = JSON.parse(await command(["pack", "--ignore-scripts", "--json"], dir));
    const archive = packed["synthetic-npm-qualification"];
    assert.equal(archive.version, version);
    assert.equal(archive.filename, `synthetic-npm-qualification-${version}.tgz`);
    syntheticArchives.push(path.join(dir, archive.filename));
  }
  const target = path.join(root, "install");
  await fs.mkdir(target);
  await fs.writeFile(
    path.join(target, "package.json"),
    JSON.stringify({
      name: "synthetic-consumer",
      private: true,
    }),
    { flag: "wx" },
  );
  report.phases = [];
  for (const index of [0, 1, 0]) {
    await command([
      "install",
      "--prefix",
      target,
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      syntheticArchives[index],
    ]);
    const installed = path.join(target, "node_modules/synthetic-npm-qualification");
    const meta = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
    assert.equal(meta.version, index === 0 ? "1.0.0" : "1.0.1");
    await assert.rejects(fs.lstat(path.join(installed, "script-ran")), { code: "ENOENT" });
    report.phases.push({ version: meta.version, installScriptSuppressed: true });
  }
  await runConsumers({ packageRoot, runtime, root: path.join(root, "consumers"), report });
  report.carrierRoundtrip = { requested: Boolean(archives), passed: false };
  if (verified) {
    await runCarrierRoundtrip({
      verified,
      installer: consumers,
      runtime,
      root: path.join(root, "carrier-roundtrip"),
      report: report.carrierRoundtrip,
    });
  }
  report.passed = true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = {
    protocol: "npm-node-gyp-consumer-v1",
    node: process.version,
    platform: process.platform,
    syntheticOnly: true,
    nativeCompilationVerified: false,
    requestAbortSignalSupported: false,
    containment: "outer-linux-qualification-scope-required",
    passed: false,
  };
  try {
    await runInstalledNpmProof(parseArguments(process.argv.slice(2)), report);
  } catch (error) {
    report.error = error instanceof Error ? error.message.slice(0, 8192) : "npm proof failed";
    process.exitCode = 1;
  } finally {
    console.log(JSON.stringify(report));
  }
}
