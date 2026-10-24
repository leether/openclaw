import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HEADER_FILES, startFixture, TARGET } from "./loopback.mjs";
import { managedCommand } from "./managed.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CASES = [
  "direct-ensure",
  "explicit-proxy",
  "environment-proxy",
  "no-proxy",
  "bad-checksum",
  "cancel-before-headers",
  "cancel-during-body",
  "destroy-returned-body",
];
const hash = (data) => createHash("sha256").update(data).digest("hex");

export function within(root, candidate) {
  const relative = path.relative(root, candidate);
  assert.ok(
    relative && !path.isAbsolute(relative) && !relative.split(path.sep).includes(".."),
    "consumer escaped installed prefix",
  );
  return relative.split(path.sep).join("/");
}

async function metadata(filename) {
  const data = await fs.readFile(filename);
  assert.ok(data.length < 65536);
  return { value: JSON.parse(data), sha256: hash(data) };
}

export async function resolveConsumers(packageRoot, expectedUndici = "6.29.1") {
  assert.ok(["6.29.0", "6.29.1"].includes(expectedUndici));
  const prefix = await fs.realpath(packageRoot);
  const resolve = createRequire(path.join(prefix, "package.json"));
  const npmManifest = await fs.realpath(resolve.resolve("npm/package.json"));
  const npmRoot = path.dirname(npmManifest);
  const npmResolve = createRequire(npmManifest);
  const gypManifest = await fs.realpath(npmResolve.resolve("node-gyp/package.json"));
  const gypResolve = createRequire(gypManifest);
  const undiciManifest = await fs.realpath(gypResolve.resolve("undici/package.json"));
  const entries = {};
  for (const [name, filename, version] of [
    ["npm", npmManifest, "12.2.1"],
    ["node-gyp", gypManifest, "13.0.0"],
    ["undici", undiciManifest, expectedUndici],
  ]) {
    const meta = await metadata(filename);
    assert.equal(meta.value.name, name);
    assert.equal(meta.value.version, version);
    entries[name] = { version, package: within(prefix, filename), sha256: meta.sha256 };
  }
  assert.equal(path.dirname(gypManifest), path.join(npmRoot, "node_modules/node-gyp"));
  assert.equal(path.dirname(undiciManifest), path.join(npmRoot, "node_modules/undici"));
  const files = {};
  for (const relative of [
    "bin/npm-cli.js",
    "node_modules/node-gyp/bin/node-gyp.js",
    "node_modules/node-gyp/lib/download.js",
    "node_modules/node-gyp/lib/install.js",
    "node_modules/node-gyp/lib/process-release.js",
    "node_modules/undici/index.js",
  ]) {
    const file = await fs.realpath(path.join(npmRoot, relative));
    files[relative] = { path: within(prefix, file), sha256: hash(await fs.readFile(file)) };
  }
  return {
    npmRoot,
    npmCli: path.join(npmRoot, "bin/npm-cli.js"),
    identity: { packages: entries, files },
  };
}

export async function assertLinuxLoopbackNamespace() {
  assert.equal(process.platform, "linux", "actual consumer qualification requires Linux");
  assert.equal(process.env.QUALIFICATION_NETWORK_ISOLATED, "1");
  const net = await fs.readFile("/proc/net/dev", "utf8");
  const interfaces = net
    .split("\n")
    .filter((line) => line.includes(":"))
    .map((line) => line.split(":")[0].trim())
    .toSorted();
  assert.deepEqual(interfaces, ["lo"], "qualification namespace has non-loopback interfaces");
  const namespace = await fs.readlink("/proc/self/ns/net");
  assert.match(namespace, /^net:\[[0-9]+\]$/);
  return { platform: "linux", interfaces, namespace, externallyRoutedInterfacePresent: false };
}

export async function isolatedEnvironment(root, runtime) {
  await fs.mkdir(root);
  for (const child of ["home", "cache", "tmp"]) {
    await fs.mkdir(path.join(root, child));
  }
  const config = path.join(root, "empty.npmrc");
  await fs.writeFile(config, "", { flag: "wx" });
  return {
    HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    PATH: path.dirname(runtime) + ":/usr/bin:/bin",
    LANG: "C",
    TZ: "UTC",
    npm_config_cache: path.join(root, "cache"),
    npm_config_userconfig: config,
    npm_config_globalconfig: config,
    npm_config_registry: "http://127.0.0.1:9",
    npm_config_offline: "true",
  };
}

export function validateEvents(events, fixture, identity) {
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.ok(["request", "headers"].includes(event.kind));
    assert.ok(["origin", "proxy"].includes(event.transport));
    if (event.transport === "origin") {
      assert.ok(event.pathname.startsWith(`/${fixture.nonce}/v${TARGET}/`));
    } else {
      assert.equal(event.pathname, "CONNECT");
    }
    assert.equal(event.nonce, fixture.nonce);
    assert.equal(event.download, "node_modules/node-gyp/lib/download.js");
    assert.equal(event.undiciEntry, "node_modules/undici/index.js");
    assert.equal(event.undiciVersion, identity.packages.undici.version);
    assert.equal(event.undiciPackageSha256, identity.packages.undici.sha256);
    assert.ok(Number.isSafeInteger(event.pid) && event.pid > 1);
  }
  assert.ok(events.some((event) => event.kind === "request" && event.transport === "origin"));
}

export function publicCommand(receipt) {
  const { stdout: _stdout, events, ...rest } = receipt;
  return { ...rest, events };
}

async function verifyHeaders(devdir) {
  const output = {};
  for (const [relative, expected] of Object.entries(HEADER_FILES)) {
    const data = await fs.readFile(path.join(devdir, TARGET, relative));
    assert.equal(data.toString(), expected);
    output[relative] = hash(data);
  }
  assert.equal(await fs.readFile(path.join(devdir, TARGET, "installVersion"), "utf8"), "11\n");
  return output;
}

async function installedMarkerExists(devdir) {
  try {
    await fs.stat(path.join(devdir, TARGET, "installVersion"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function runConsumerCase(
  name,
  { consumers, runtime, root, command = managedCommand },
) {
  assert.ok(CASES.includes(name));
  const env = await isolatedEnvironment(root, runtime);
  const cancel = new AbortController();
  let held = false;
  const mode =
    name === "bad-checksum"
      ? "bad-checksum"
      : name === "cancel-before-headers"
        ? "hold-before-headers"
        : ["cancel-during-body", "destroy-returned-body"].includes(name)
          ? "hold-body"
          : "normal";
  const fixture = await startFixture({
    mode,
    onHeld() {
      held = true;
      if (name === "cancel-before-headers") {
        cancel.abort(new Error("synthetic CLI cancellation"));
      }
    },
  });
  const receipt = { name, passed: false, commands: [], requestAbortSignalSupported: false };
  try {
    const devdir = path.join(root, "headers");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "synthetic-node-gyp-consumer",
        version: "1.0.0",
        private: true,
        scripts: { "gyp-proof": "node-gyp install" },
      }),
      { flag: "wx" },
    );
    const config = path.join(root, "consumer.json");
    await fs.writeFile(
      config,
      JSON.stringify({
        npmRoot: consumers.npmRoot,
        nonce: fixture.nonce,
        origin: fixture.origin,
        proxy: fixture.proxy,
        url: fixture.url,
        expectedUndici: consumers.identity.packages.undici.version,
      }),
      { flag: "wx" },
    );
    env.NPM_CONSUMER_CONFIG = config;
    env.NODE_OPTIONS = `--max-old-space-size=512 --require=${JSON.stringify(path.join(here, "observe.cjs"))}`;
    const proxyArgs = [];
    if (name === "explicit-proxy" || name === "no-proxy") {
      proxyArgs.push(`--proxy=${fixture.proxy}`);
    }
    if (name === "environment-proxy") {
      env.HTTP_PROXY = fixture.proxy;
    }
    if (name === "no-proxy") {
      proxyArgs.push("--noproxy=127.0.0.1");
    }
    const cliArgs = [
      consumers.npmCli,
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "run",
      "gyp-proof",
      "--",
      `--target=${TARGET}`,
      `--dist-url=${fixture.distUrl}`,
      `--devdir=${devdir}`,
      ...proxyArgs,
    ];
    const isCancellation = name.startsWith("cancel-");
    const result = await command({
      runtime,
      args: name === "destroy-returned-body" ? [path.join(here, "body-worker.cjs")] : cliArgs,
      cwd: root,
      env,
      signal: cancel.signal,
      expectCancellation: isCancellation,
      onEvent(event) {
        if (
          name === "cancel-during-body" &&
          event.kind === "headers" &&
          event.transport === "origin"
        ) {
          assert.ok(held);
          cancel.abort(new Error("synthetic CLI body cancellation"));
        }
      },
    });
    receipt.commands.push(publicCommand(result));
    validateEvents(result.events, fixture, consumers.identity);
    await fixture.waitClosed();
    const beforeEnsure = fixture.counts;
    assert.equal(beforeEnsure.unexpected, null);
    assert.equal(beforeEnsure.openSockets, 0);
    const expectedPaths =
      isCancellation || name === "destroy-returned-body"
        ? [`node-v${TARGET}-headers.tar.gz`]
        : [`node-v${TARGET}-headers.tar.gz`, "SHASUMS256.txt"];
    assert.deepEqual(
      beforeEnsure.requests.map((r) => r.path),
      expectedPaths,
    );
    if (isCancellation) {
      assert.ok(held && cancel.signal.aborted);
      assert.equal(await installedMarkerExists(devdir), false);
      receipt.cancellation = {
        mode: "owned-cli-process-group",
        heldRequestObserved: true,
        actualProcessesJoined: result.joined,
        socketsClosed: true,
        callerAbortSignalForwardedToFetch: false,
        partialStateMayRemain: true,
      };
      // SIGTERM need not run node-gyp's JS rollback/finally; retain partial state.
      receipt.remainingTemporaryNames = (await fs.readdir(env.TMPDIR)).slice(0, 32);
    } else if (name === "bad-checksum") {
      assert.equal(result.status, 1);
      assert.equal(result.checksumRejected, true);
      await assert.rejects(fs.stat(path.join(devdir, TARGET)), { code: "ENOENT" });
      assert.equal(
        (await fs.readdir(env.TMPDIR)).filter((entry) => entry.startsWith("node-gyp-tmp-")).length,
        0,
      );
      receipt.rollbackVerified = true;
    } else if (name === "destroy-returned-body") {
      assert.equal(result.status, 0);
      const body = JSON.parse(result.stdout);
      assert.deepEqual(body, {
        passed: true,
        headersReceived: true,
        bodyErrorObserved: true,
        bodyClosed: true,
        requestAbortSignalSupported: false,
      });
      receipt.returnedBodyDestroyVerified = true;
    } else {
      assert.equal(result.status, 0);
      receipt.headerSha256 = await verifyHeaders(devdir);
      assert.deepEqual(
        beforeEnsure.requests.map((r) => r.path),
        [`node-v${TARGET}-headers.tar.gz`, "SHASUMS256.txt"],
      );
      if (["explicit-proxy", "environment-proxy"].includes(name)) {
        assert.ok(beforeEnsure.proxyConnects > 0);
      } else {
        assert.equal(beforeEnsure.proxyConnects, 0);
      }
      if (name === "direct-ensure") {
        const ensure = await command({ runtime, args: [...cliArgs, "--ensure"], cwd: root, env });
        receipt.commands.push(publicCommand(ensure));
        assert.equal(ensure.status, 0);
        assert.equal(ensure.events.length, 0);
        assert.deepEqual(fixture.counts.requests, beforeEnsure.requests);
        assert.deepEqual(await verifyHeaders(devdir), receipt.headerSha256);
        receipt.ensureAvoidedDownload = true;
      }
    }
    receipt.transport = fixture.counts;
    receipt.passed = true;
  } catch (error) {
    receipt.error = error instanceof Error ? error.message.slice(0, 8192) : "consumer proof failed";
    if (error && typeof error === "object" && error.receipt) {
      receipt.failedCommand = error.receipt;
    }
  }
  try {
    receipt.cleanup = await fixture.close();
  } catch {
    receipt.passed = false;
    receipt.cleanup = { failed: true };
  }
  if (!receipt.passed) {
    throw Object.assign(new Error(`npm consumer ${name} failed`), { receipt });
  }
  return receipt;
}

export async function runConsumers({ packageRoot, runtime, root, report }) {
  const consumers = await resolveConsumers(packageRoot);
  if (report.identity) {
    assert.deepEqual(consumers.identity, report.identity, "main consumer identity changed");
  }
  report.identity = consumers.identity;
  report.network = await assertLinuxLoopbackNamespace();
  report.requestAbortSignalSupported = false;
  report.consumerCases = [];
  await fs.mkdir(root);
  for (const name of CASES) {
    try {
      report.consumerCases.push(
        await runConsumerCase(name, {
          consumers,
          runtime,
          root: path.join(root, name),
        }),
      );
    } catch (error) {
      if (error.receipt) {
        report.consumerCases.push(error.receipt);
      }
      throw error;
    }
  }
  return consumers;
}
