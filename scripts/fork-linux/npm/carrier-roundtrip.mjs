import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  BUNDLED_NPM_CONTRACT,
  readBundledNpmPackageArchive,
  verifyBundledNpmArtifact,
} from "../../lib/package-bundled-npm.mts";
import {
  isolatedEnvironment,
  publicCommand,
  resolveConsumers,
  runConsumerCase,
} from "./consumer-proof.mjs";
import { managedCommand } from "./managed.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function boundedArchive(filename) {
  const stat = await fs.lstat(filename);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 4 * 1024 * 1024);
  const bytes = await fs.readFile(filename);
  assert.equal(bytes.length, stat.size);
  return bytes;
}

// Only compare regular package payload files. Installation metadata outside this
// package root is not part of either official or derived package inventory.
export async function verifyInstalledPayload(root, expected) {
  const pending = [""];
  const actual = [];
  let bytes = 0;
  let entries = 0;
  while (pending.length) {
    const relative = pending.pop();
    const dir = await fs.opendir(path.join(root, relative));
    for await (const item of dir) {
      assert.ok(++entries <= 8192, "installed npm entry bound");
      const name = relative ? `${relative}/${item.name}` : item.name;
      const filename = path.join(root, name);
      const stat = await fs.lstat(filename);
      assert.equal(stat.isSymbolicLink(), false, "unexpected link in npm payload");
      if (stat.isDirectory()) {
        pending.push(name);
        continue;
      }
      assert.ok(stat.isFile() && stat.size <= 1024 * 1024);
      bytes += stat.size;
      assert.ok(bytes <= 16 * 1024 * 1024 && actual.length < 4096);
      const content = await fs.readFile(filename);
      assert.equal(content.length, stat.size);
      actual.push({
        path: name,
        bytes: content.length,
        mode: stat.mode & 0o777,
        sha256: digest(content),
      });
    }
  }
  const wanted = expected.map((file) => ({
    path: file.path,
    bytes: file.content.byteLength,
    mode: file.mode,
    sha256: digest(file.content),
  }));
  const order = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  actual.sort(order);
  wanted.sort(order);
  assert.deepEqual(actual, wanted, "installed npm payload differs from verified archive");
  return { files: actual.length, bytes, treeSha256: digest(Buffer.from(JSON.stringify(actual))) };
}

// Authenticate once before any installed CLI can run. Retain the verified bytes
// for the later carrier roundtrip rather than reopening mutable input paths.
export async function authenticateCarrierInputs(archives) {
  assert.equal(archives.length, 3);
  const buffers = [];
  for (const filename of archives) {
    buffers.push(await boundedArchive(filename));
  }
  const [npmTarball, undiciTarball, derivedTarball] = buffers;
  const authority = verifyBundledNpmArtifact({ npmTarball, undiciTarball, derivedTarball });
  return {
    npmTarball,
    derivedTarball,
    authority,
    officialFiles: readBundledNpmPackageArchive(npmTarball),
    derivedFiles: readBundledNpmPackageArchive(derivedTarball),
    authentication: {
      officialInputs: authority.provenance.officialInputs,
      derivedTreeSha256: authority.provenance.derivedTreeSha256,
      derivedArchiveIntegrity: authority.integrity,
      archiveSha256: buffers.map(digest),
    },
  };
}

export async function verifyMainNpmPayload(npmRoot, verified) {
  const inventory = await verifyInstalledPayload(npmRoot, verified.derivedFiles);
  assert.equal(inventory.files, BUNDLED_NPM_CONTRACT.derivedFiles);
  assert.equal(inventory.treeSha256, BUNDLED_NPM_CONTRACT.derivedTreeSha256);
  return inventory;
}

// The installer stays outside the prefix being updated. Replacing its own files
// while it runs would not qualify an independent install or rollback.
export async function runCarrierRoundtrip({ verified, installer, runtime, root, report }) {
  const { npmTarball, derivedTarball, authority, officialFiles, derivedFiles } = verified;
  Object.assign(report, verified.authentication, { requested: true, passed: false });
  report.phases = [];
  const env = await isolatedEnvironment(root, runtime);
  // Freeze verified bytes into this invocation's private, empty input directory.
  const inputDir = path.join(root, "inputs");
  await fs.mkdir(inputDir);
  const officialPath = path.join(inputDir, "npm-official.tgz");
  const derivedPath = path.join(inputDir, "npm-derived.tgz");
  await fs.writeFile(officialPath, npmTarball, { flag: "wx" });
  await fs.writeFile(derivedPath, derivedTarball, { flag: "wx" });
  const prefix = path.join(root, "prefix");
  await fs.mkdir(prefix);
  await fs.writeFile(
    path.join(prefix, "package.json"),
    JSON.stringify({
      name: "synthetic-npm-carrier-consumer",
      private: true,
      version: "1.0.0",
    }),
    { flag: "wx" },
  );
  for (const [stage, archive, expected, version] of [
    ["official-before", officialPath, officialFiles, "6.29.0"],
    ["derived", derivedPath, derivedFiles, "6.29.1"],
    ["official-rollback", officialPath, officialFiles, "6.29.0"],
  ]) {
    const receipt = { stage, passed: false };
    report.phases.push(receipt);
    const command = await managedCommand({
      runtime,
      args: [
        installer.npmCli,
        "install",
        "--prefix",
        prefix,
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        archive,
      ],
      cwd: root,
      env,
    });
    receipt.install = publicCommand(command);
    assert.equal(command.status, 0);
    receipt.inventory = await verifyInstalledPayload(
      path.join(prefix, "node_modules/npm"),
      expected,
    );
    const lockBytes = await fs.readFile(path.join(prefix, "package-lock.json"));
    assert.ok(lockBytes.length <= 262144);
    const lock = JSON.parse(lockBytes);
    const npm = lock.packages["node_modules/npm"];
    const gyp = lock.packages["node_modules/npm/node_modules/node-gyp"];
    const undici = lock.packages["node_modules/npm/node_modules/undici"];
    const expectedIntegrity =
      stage === "derived" ? authority.integrity : BUNDLED_NPM_CONTRACT.npmIntegrity;
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(npm.version, "12.2.1");
    assert.equal(npm.integrity, expectedIntegrity);
    assert.equal(gyp.version, "13.0.0");
    assert.equal(gyp.inBundle, true);
    assert.equal(undici.version, version);
    assert.equal(undici.inBundle, true);
    receipt.lock = {
      sha256: digest(lockBytes),
      bytes: lockBytes.length,
      lockfileVersion: 3,
      npmIntegrity: expectedIntegrity,
      npmVersion: npm.version,
      nodeGypVersion: gyp.version,
      undiciVersion: undici.version,
      nodeGypInBundle: true,
      undiciInBundle: true,
    };
    const actual = await resolveConsumers(prefix, version);
    receipt.identity = actual.identity;
    receipt.consumer = await runConsumerCase("direct-ensure", {
      consumers: actual,
      runtime,
      root: path.join(root, stage),
    });
    receipt.passed = true;
  }
  assert.equal(report.phases[0].inventory.treeSha256, report.phases[2].inventory.treeSha256);
  assert.equal(report.phases[0].lock.sha256, report.phases[2].lock.sha256);
  report.passed = true;
}
