import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import { test } from "vitest";
import { parseArguments } from "../../scripts/fork-linux/installed-npm-proof.mjs";
import {
  authenticateCarrierInputs,
  verifyInstalledPayload,
  verifyMainNpmPayload,
} from "../../scripts/fork-linux/npm/carrier-roundtrip.mjs";
import { CASES, validateEvents, within } from "../../scripts/fork-linux/npm/consumer-proof.mjs";
import {
  proxyTargetAllowed,
  startFixture,
  syntheticHeaders,
  TARGET,
} from "../../scripts/fork-linux/npm/loopback.mjs";
import { managedCommand, OUTPUT_LIMIT } from "../../scripts/fork-linux/npm/managed.mjs";
import {
  OWNER_TEST_FILES,
  LIFECYCLE_TEST_FILE,
  OFFICIAL_FIXTURE_TESTS,
  verifyOwnerTests,
} from "../../scripts/fork-linux/npm/owner-test-contract.mjs";
import {
  assertNpmQualification,
  collectNpmQualification,
} from "../../scripts/fork-linux/npm/qualification.mjs";
import type { RunManagedCommandOptions } from "../../scripts/lib/managed-child-process.mts";
import { BUNDLED_NPM_CONTRACT } from "../../scripts/lib/package-bundled-npm.mts";

const commandBase = {
  runtime: process.execPath,
  args: ["synthetic-no-spawn"],
  cwd: os.tmpdir(),
  env: {},
};
function fakeChild() {
  return Object.assign(new ChildProcess(), {
    pid: 12345,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}
function finish(child: ReturnType<typeof fakeChild>) {
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
}
const dead = () => "dead" as const;

test("npm proof keeps three-argument invocation and makes carrier inputs explicit", () => {
  assert.equal(parseArguments(["/pkg", "/node", "/state"]).archives, null);
  assert.deepEqual(
    parseArguments([
      "/pkg",
      "/node",
      "/state",
      "--carrier-roundtrip",
      "/npm",
      "/undici",
      "/derived",
    ]).archives,
    ["/npm", "/undici", "/derived"],
  );
  assert.throws(() => parseArguments(["/pkg", "/node"]));
  assert.throws(() => parseArguments(["/pkg", "/node", "/state", "--unknown", "/a", "/b", "/c"]));
});

test("managed command uses the real owner's strict tree/output terminal contract", async () => {
  const receipt = await managedCommand({
    ...commandBase,
    inspect: dead,
    owner: async (options: RunManagedCommandOptions) => {
      assert.equal(options.requireProcessTreeExit, true);
      assert.equal(options.timeoutMs, 25000);
      assert.equal(options.abortKillGraceMs, 3500);
      assert.equal(options.args?.[0], "--max-old-space-size=512");
      const child = fakeChild();
      options.onReady?.(child);
      child.stdout.write("bounded");
      finish(child);
      return 0;
    },
  });
  assert.equal(receipt.joined, true);
  assert.equal(receipt.closed, true);
  assert.equal(receipt.stdout, "bounded");
});

for (const state of ["live", "indeterminate"] as const) {
  test(`numeric success cannot qualify a ${state} process group`, async () => {
    await assert.rejects(
      managedCommand({
        ...commandBase,
        inspect: () => state,
        owner: async (options: RunManagedCommandOptions) => {
          const child = fakeChild();
          options.onReady?.(child);
          finish(child);
          return 0;
        },
      }),
      /did not terminate/,
    );
  });
}

test("process-group absence without child close is not termination", async () => {
  await assert.rejects(
    managedCommand({
      ...commandBase,
      inspect: dead,
      owner: async (options: RunManagedCommandOptions) => {
        const child = fakeChild();
        options.onReady?.(child);
        return 0;
      },
    }),
    /did not terminate/,
  );
});

test("fixture cancellation requires ABORT_ERR after joined group and real close", async () => {
  const controller = new AbortController();
  const receipt = await managedCommand({
    ...commandBase,
    signal: controller.signal,
    expectCancellation: true,
    inspect: dead,
    owner: async (options: RunManagedCommandOptions) => {
      const child = fakeChild();
      options.onReady?.(child);
      controller.abort();
      assert.equal(options.signal?.aborted, true);
      finish(child);
      throw Object.assign(new Error("fixture abort"), { code: "ABORT_ERR" });
    },
  });
  assert.equal(receipt.joined, true);
  assert.equal(receipt.expectedCancellation, true);
  assert.ok(receipt.cancellationMs !== null && receipt.cancellationMs < 3500);
});

for (const code of ["ETIMEDOUT", "EPROCESSGROUP_CLEANUP_FAILED"]) {
  test(`cancellation does not accept ${code} as a successful abort`, async () => {
    const controller = new AbortController();
    await assert.rejects(
      managedCommand({
        ...commandBase,
        signal: controller.signal,
        expectCancellation: true,
        inspect: dead,
        owner: async (options: RunManagedCommandOptions) => {
          const child = fakeChild();
          options.onReady?.(child);
          controller.abort();
          finish(child);
          throw Object.assign(new Error("fixture failure"), { code });
        },
      }),
    );
  });
}

test("combined output above the cap remains failed even after status zero", async () => {
  await assert.rejects(
    managedCommand({
      ...commandBase,
      inspect: dead,
      owner: async (options: RunManagedCommandOptions) => {
        const child = fakeChild();
        options.onReady?.(child);
        child.stdout.write(Buffer.alloc(OUTPUT_LIMIT));
        child.stderr.write("x");
        finish(child);
        return 0;
      },
    }),
    /output-limit/,
  );
});

test("split diagnostic lines are bounded and retain exact evidence", async () => {
  const seen: unknown[] = [];
  const receipt = await managedCommand({
    ...commandBase,
    inspect: dead,
    onEvent: (event: unknown) => seen.push(event),
    owner: async (options: RunManagedCommandOptions) => {
      const child = fakeChild();
      options.onReady?.(child);
      child.stderr.write('NPM_CONSUMER_EVENT {"kind":');
      child.stderr.write('"request"}\n');
      child.stderr.write(
        `gyp ERR! node-v24.22.1-headers.tar.gz local checksum ${"a".repeat(64)} not match remote ${"0".repeat(64)}\n`,
      );
      finish(child);
      return 1;
    },
  });
  assert.deepEqual(seen, [{ kind: "request" }]);
  assert.equal(receipt.checksumRejected, true);
  assert.equal(receipt.status, 1);
});

test("malformed diagnostic evidence cannot become a successful command", async () => {
  await assert.rejects(
    managedCommand({
      ...commandBase,
      inspect: dead,
      owner: async (options: RunManagedCommandOptions) => {
        const child = fakeChild();
        options.onReady?.(child);
        child.stderr.write("NPM_CONSUMER_EVENT invalid\n");
        finish(child);
        return 0;
      },
    }),
    /invalid-consumer-event/,
  );
});

const fixtureIdentity = { packages: { undici: { version: "6.29.1", sha256: "a".repeat(64) } } };
const goodEvent = {
  kind: "request",
  transport: "origin",
  nonce: "nonce",
  pid: 12345,
  download: "node_modules/node-gyp/lib/download.js",
  undiciEntry: "node_modules/undici/index.js",
  undiciVersion: "6.29.1",
  undiciPackageSha256: "a".repeat(64),
  pathname: `/nonce/v${TARGET}/node-v${TARGET}-headers.tar.gz`,
};
test("consumer evidence binds loaded module, package identity and nonce", () => {
  validateEvents([goodEvent], { nonce: "nonce" }, fixtureIdentity);
});
for (const [key, value] of Object.entries({
  nonce: "other",
  undiciVersion: "6.29.0",
  undiciEntry: "../undici/index.js",
  download: "mock/download.js",
  undiciPackageSha256: "b".repeat(64),
  pathname: "/other/a",
  transport: "unknown",
  pid: 0,
})) {
  test(`consumer evidence refuses mismatched ${key}`, () => {
    assert.throws(() =>
      validateEvents([{ ...goodEvent, [key]: value }], { nonce: "nonce" }, fixtureIdentity),
    );
  });
}
test("proxy-only diagnostics cannot impersonate a node-gyp origin request", () => {
  assert.throws(() =>
    validateEvents(
      [{ ...goodEvent, transport: "proxy", pathname: "CONNECT" }],
      { nonce: "nonce" },
      fixtureIdentity,
    ),
  );
});

test("proxy allowlist is exact and cannot become an external forward proxy", () => {
  assert.equal(proxyTargetAllowed("127.0.0.1:1234", 1234), true);
  for (const value of [
    "localhost:1234",
    "127.0.0.1:1235",
    "127.0.0.1:1234@evil",
    "10.0.0.1:1234",
    "example.com:1234",
  ]) {
    assert.equal(proxyTargetAllowed(value, 1234), false);
  }
});
test("installed package containment refuses sibling, parent and identical root", () => {
  assert.equal(within("/prefix", "/prefix/npm/package.json"), "npm/package.json");
  for (const candidate of ["/other/npm/package.json", "/prefix-two/package.json", "/prefix"]) {
    assert.throws(() => within("/prefix", candidate));
  }
});
test("synthetic header archive is small and contains only two declared inputs", () => {
  const tgz = syntheticHeaders();
  assert.ok(tgz.length < 32768);
  const tar = gunzipSync(tgz, { maxOutputLength: 8192 });
  assert.ok(tar.includes(Buffer.from(`node-v${TARGET}/include/node/fixture.h`)));
  assert.ok(tar.includes(Buffer.from(`node-v${TARGET}/include/node/fixture.gypi`)));
  assert.ok(tar.subarray(-1024).every((byte) => byte === 0));
});

async function temporary(fn: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "npm-proof-pure-"));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
test("full payload comparison rejects changed bytes, extra files and links", () =>
  temporary(async (root) => {
    const file = path.join(root, "index.js");
    await fs.writeFile(file, "synthetic\n", { mode: 0o644 });
    const expected = [{ path: "index.js", mode: 0o644, content: Buffer.from("synthetic\n") }];
    assert.equal((await verifyInstalledPayload(root, expected)).files, 1);
    await fs.writeFile(file, "changed\n");
    await assert.rejects(verifyInstalledPayload(root, expected));
    await fs.writeFile(file, "synthetic\n");
    await fs.writeFile(path.join(root, "extra.js"), "x");
    await assert.rejects(verifyInstalledPayload(root, expected));
    await fs.unlink(path.join(root, "extra.js"));
    await fs.symlink(file, path.join(root, "unexpected-link"));
    await assert.rejects(verifyInstalledPayload(root, expected), /unexpected link/);
  }));

test("main payload comparison covers an unlisted Undici implementation and file modes", () =>
  temporary(async (root) => {
    const entries = [
      { path: "node_modules/undici/index.js", mode: 0o644, content: Buffer.from("entry\n") },
      {
        path: "node_modules/undici/lib/web/fetch/index.js",
        mode: 0o644,
        content: Buffer.from("implementation\n"),
      },
    ];
    for (const entry of entries) {
      const file = path.join(root, entry.path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, entry.content, { mode: entry.mode });
    }
    assert.equal((await verifyInstalledPayload(root, entries)).files, 2);
    const entry = entries[1];
    assert.ok(entry);
    const unlisted = path.join(root, entry.path);
    await fs.writeFile(unlisted, "drift hidden from sampled entry hashes\n");
    await assert.rejects(verifyInstalledPayload(root, entries), /payload differs/);
    await assert.rejects(verifyMainNpmPayload(root, { derivedFiles: entries }), /payload differs/);
    await fs.writeFile(unlisted, entry.content);
    await fs.chmod(unlisted, 0o755);
    await assert.rejects(verifyMainNpmPayload(root, { derivedFiles: entries }), /payload differs/);
    await fs.chmod(unlisted, entry.mode);
    // Matching arbitrary files cannot substitute for the fixed official derivation.
    await assert.rejects(verifyMainNpmPayload(root, { derivedFiles: entries }));
  }));

test("formal carrier authentication refuses non-official bytes before returning any input", () =>
  temporary(async (root) => {
    const archives = ["npm.tgz", "undici.tgz", "derived.tgz"].map((p) => path.join(root, p));
    for (const archive of archives) {
      await fs.writeFile(archive, "not an official input");
    }
    await assert.rejects(authenticateCarrierInputs(archives));
    await assert.rejects(authenticateCarrierInputs(archives.slice(0, 2)));
  }));

// These small loopback server tests exercise only fixture plumbing. They never
// count as Linux npm/node-gyp consumer qualification, on macOS or on Linux.
async function tunneledGet(proxyUrl: string, originUrl: string, resource: string) {
  const proxy = new URL(proxyUrl);
  const origin = new URL(originUrl);
  return await new Promise<string>((resolve, reject) => {
    const request = http.request({
      hostname: proxy.hostname,
      port: proxy.port,
      method: "CONNECT",
      path: origin.host,
    });
    request.setTimeout(2000, () => request.destroy(new Error("fixture timeout")));
    request.once("error", reject);
    request.once("connect", (response, socket, head) => {
      assert.equal(response.statusCode, 200);
      let result = head.toString();
      socket.setTimeout(2000, () => socket.destroy(new Error("fixture timeout")));
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        result += chunk.toString();
      });
      socket.once("end", () => resolve(result));
      socket.write(
        `GET ${resource} HTTP/1.1\r\nHost: ${origin.host}\r\nUser-Agent: node-gyp v13.0.0 (node v24.22.1)\r\nConnection: close\r\n\r\n`,
      );
    });
    request.end();
  });
}
test("loopback proxy actually forwards one exact CONNECT target and closes both sides", async () => {
  const fixture = await startFixture();
  try {
    const response = await tunneledGet(
      fixture.proxy,
      fixture.origin,
      new URL(fixture.url).pathname,
    );
    assert.match(response, /^HTTP\/1.1 200/);
    await fixture.waitClosed();
    assert.equal(fixture.counts.proxyConnects, 1);
    assert.equal(fixture.counts.requests.length, 1);
    assert.equal(fixture.counts.openSockets, 0);
    assert.equal(fixture.counts.unexpected, null);
  } finally {
    await fixture.close();
  }
});
test("held HTTP request remains open until the actual client socket closes", async () => {
  let closeClient: (() => void) | undefined;
  let heldResolve: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    heldResolve = resolve;
  });
  const fixture = await startFixture({
    mode: "hold-before-headers",
    onHeld() {
      heldResolve?.();
    },
  });
  try {
    const closed = new Promise<void>((resolve, reject) => {
      const request = http.get(fixture.url, {
        headers: { "User-Agent": "node-gyp v13.0.0 (node v24.22.1)" },
      });
      closeClient = () => request.destroy();
      request.setTimeout(2000, () => request.destroy(new Error("fixture timeout")));
      request.on("error", (error) => {
        if (error.message === "fixture timeout") {
          reject(error);
        }
      });
      request.once("close", resolve);
    });
    await held;
    assert.equal(fixture.counts.openSockets, 1);
    closeClient?.();
    await closed;
    await fixture.waitClosed();
    assert.equal(fixture.counts.openSockets, 0);
  } finally {
    closeClient?.();
    await fixture.close();
  }
});

// Deliberately fabricated reports test the aggregator's fail-closed contract;
// these are never qualified consumer execution evidence.
function qualifyingReport(version = "24.22.1") {
  const digest = "a".repeat(64);
  const nonce = "a".repeat(36);
  function packageIdentity(undiciVersion: string, npmPrefix = "node_modules/npm/") {
    return {
      packages: Object.fromEntries(
        [
          ["npm", "12.2.1"],
          ["node-gyp", "13.0.0"],
          ["undici", undiciVersion],
        ].map(([name, v]) => [
          name,
          {
            version: v,
            package:
              npmPrefix + (name === "npm" ? "package.json" : `node_modules/${name}/package.json`),
            sha256: digest,
          },
        ]),
      ),
      files: Object.fromEntries(
        [
          "bin/npm-cli.js",
          "node_modules/node-gyp/bin/node-gyp.js",
          "node_modules/node-gyp/lib/download.js",
          "node_modules/node-gyp/lib/install.js",
          "node_modules/node-gyp/lib/process-release.js",
          "node_modules/undici/index.js",
        ].map((p) => [p, { path: npmPrefix + p, sha256: digest }]),
      ),
    };
  }
  function commandReceipt(cancellation = false, status = 0) {
    return {
      status,
      closed: true,
      joined: true,
      processGroupState: "dead",
      processGroupId: 12345,
      elapsedMs: 10,
      outputBytes: 0,
      fault: null,
      stderrSha256: digest,
      expectedCancellation: cancellation,
      errorCode: cancellation ? "ABORT_ERR" : null,
      cancellationMs: cancellation ? 5 : null,
      events: [] as Array<Record<string, unknown>>,
      checksumRejected: status === 1,
    };
  }
  function consumerReceipt(name: string, undiciVersion = "6.29.1") {
    const cancellation = name.startsWith("cancel-");
    const proxied = ["explicit-proxy", "environment-proxy"].includes(name);
    const receipt = commandReceipt(cancellation, name === "bad-checksum" ? 1 : 0);
    receipt.events.push({
      ...goodEvent,
      nonce,
      undiciVersion,
      pathname: `/${nonce}/v${TARGET}/node-v${TARGET}-headers.tar.gz`,
    });
    if (proxied) {
      receipt.events.push({
        ...goodEvent,
        nonce,
        undiciVersion,
        transport: "proxy",
        pathname: "CONNECT",
      });
    }
    return {
      name,
      passed: true,
      requestAbortSignalSupported: false,
      cleanup: { openBeforeCleanup: 0, openAfterCleanup: 0 },
      commands: name === "direct-ensure" ? [receipt, commandReceipt()] : [receipt],
      transport: {
        unexpected: null,
        openSockets: 0,
        connections: 1,
        sentBytes: 1,
        proxyConnects: proxied ? 1 : 0,
        requests: (cancellation || name === "destroy-returned-body"
          ? [`node-v${TARGET}-headers.tar.gz`]
          : [`node-v${TARGET}-headers.tar.gz`, "SHASUMS256.txt"]
        ).map((p) => ({ path: p, method: "GET" })),
      },
      cancellation: {
        mode: "owned-cli-process-group",
        heldRequestObserved: true,
        actualProcessesJoined: true,
        socketsClosed: true,
        callerAbortSignalForwardedToFetch: false,
        partialStateMayRemain: true,
      },
      remainingTemporaryNames: [],
      rollbackVerified: true,
      returnedBodyDestroyVerified: true,
      ensureAvoidedDownload: true,
      headerSha256: { "include/node/fixture.gypi": digest, "include/node/fixture.h": digest },
    };
  }
  return {
    protocol: "npm-node-gyp-consumer-v1",
    node: `v${version}`,
    platform: "linux",
    syntheticOnly: true,
    nativeCompilationVerified: false,
    requestAbortSignalSupported: false,
    containment: "outer-linux-qualification-scope-required",
    passed: true,
    network: {
      platform: "linux",
      interfaces: ["lo"],
      namespace: "net:[12345]",
      externallyRoutedInterfacePresent: false,
    },
    version: "12.2.1",
    bundled: { "brace-expansion": "5.0.12", "http-cache-semantics": "4.3.0", undici: "6.29.1" },
    phases: ["1.0.0", "1.0.1", "1.0.0"].map((v) => ({ version: v, installScriptSuppressed: true })),
    commands: Array.from({ length: 6 }, () => commandReceipt()),
    qualificationEligible: true,
    mainInventory: {
      files: BUNDLED_NPM_CONTRACT.derivedFiles,
      bytes: 1,
      treeSha256: BUNDLED_NPM_CONTRACT.derivedTreeSha256,
    },
    mainAuthentication: {
      officialInputs: {
        npmIntegrity: BUNDLED_NPM_CONTRACT.npmIntegrity,
        undiciIntegrity: BUNDLED_NPM_CONTRACT.undiciIntegrity,
      },
      derivedTreeSha256: BUNDLED_NPM_CONTRACT.derivedTreeSha256,
      derivedArchiveIntegrity: "sha512-YQ==",
      archiveSha256: [digest, digest, digest],
      beforeFirstCommand: true,
    },
    identity: packageIdentity("6.29.1", "installed/node_modules/npm/"),
    consumerCases: CASES.map((name) => consumerReceipt(name)),
    carrierRoundtrip: {
      requested: true,
      passed: true,
      officialInputs: {
        npmIntegrity: BUNDLED_NPM_CONTRACT.npmIntegrity,
        undiciIntegrity: BUNDLED_NPM_CONTRACT.undiciIntegrity,
      },
      derivedTreeSha256: BUNDLED_NPM_CONTRACT.derivedTreeSha256,
      derivedArchiveIntegrity: "sha512-YQ==",
      archiveSha256: [digest, digest, digest],
      phases: ["official-before", "derived", "official-rollback"].map((stage, index) => ({
        stage,
        passed: true,
        install: commandReceipt(),
        identity: packageIdentity(index === 1 ? "6.29.1" : "6.29.0"),
        inventory: {
          files:
            index === 1 ? BUNDLED_NPM_CONTRACT.derivedFiles : BUNDLED_NPM_CONTRACT.originalFiles,
          bytes: 1,
          treeSha256: index === 1 ? BUNDLED_NPM_CONTRACT.derivedTreeSha256 : digest,
        },
        lock: {
          sha256: digest,
          bytes: 1,
          lockfileVersion: 3,
          npmVersion: "12.2.1",
          nodeGypVersion: "13.0.0",
          undiciVersion: index === 1 ? "6.29.1" : "6.29.0",
          nodeGypInBundle: true,
          undiciInBundle: true,
          npmIntegrity: index === 1 ? "sha512-YQ==" : BUNDLED_NPM_CONTRACT.npmIntegrity,
        },
        consumer: consumerReceipt("direct-ensure", index === 1 ? "6.29.1" : "6.29.0"),
      })),
    },
  };
}
function ownerReport(files: string[]) {
  const testResults = files.map((name) => ({
    name,
    status: "passed",
    assertionResults: [
      {
        title:
          Object.entries(OFFICIAL_FIXTURE_TESTS).find(([file]) => file === name)?.[1] ??
          "synthetic contract assertion",
        status: "passed",
        failureMessages: [],
      },
    ],
  }));
  return {
    success: true,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numPassedTests: files.length,
    numPendingTests: 0,
    numTotalTests: files.length,
    testResults,
  };
}
function qualifyingArtifact(name: string) {
  if (name === "npm-owner-tests.json") {
    return ownerReport(OWNER_TEST_FILES);
  }
  if (name === "npm-pack-lifecycle-tests.json") {
    return ownerReport([LIFECYCLE_TEST_FILE]);
  }
  if (name === "npm-derivation-provenance.json") {
    return {
      contract: BUNDLED_NPM_CONTRACT.version,
      derivedTreeSha256: BUNDLED_NPM_CONTRACT.derivedTreeSha256,
      unchangedOutsideUndiciCount: BUNDLED_NPM_CONTRACT.unchangedOutsideUndiciFiles,
      files: Array.from({ length: BUNDLED_NPM_CONTRACT.derivedFiles }, () => ({})),
      officialInputs: qualifyingReport().carrierRoundtrip.officialInputs,
    };
  }
  return qualifyingReport(name.includes("24.22.1") ? "24.22.1" : "24.22.0");
}
test("all four exact Node/install/restore cells and both actual owner reports are required", async () => {
  const names: string[] = [];
  const result = await collectNpmQualification(
    async (name: string) => {
      names.push(name);
      return qualifyingArtifact(name);
    },
    async () => "a".repeat(64),
  );
  assert.equal(result.passed, true);
  assert.equal(Object.keys(result.cells).length, 4);
  assert.deepEqual(names, [
    "npm-owner-tests.json",
    "npm-pack-lifecycle-tests.json",
    "npm-derivation-provenance.json",
    "installed-npm-proof-24.22.1.json",
    "installed-npm-proof-24.22.0.json",
    "restored-npm-proof-24.22.1.json",
    "restored-npm-proof-24.22.0.json",
  ]);
});
for (const field of ["inventory", "identity"] as const) {
  test(`four consistently drifted main ${field} reports cannot borrow a correct derived carrier`, async () => {
    await assert.rejects(
      collectNpmQualification(
        async (name: string) => {
          if (!name.includes("-npm-proof-")) {
            return qualifyingArtifact(name);
          }
          const proof = qualifyingReport(name.includes("24.22.1") ? "24.22.1" : "24.22.0");
          if (field === "inventory") {
            proof.mainInventory.treeSha256 = "c".repeat(64);
          } else {
            const implementation = proof.identity.files["node_modules/undici/index.js"];
            assert.ok(implementation);
            implementation.sha256 = "c".repeat(64);
          }
          return proof;
        },
        async () => "a".repeat(64),
      ),
    );
  });
}
test("each main identity must resolve its files inside its exact npm root", () => {
  const proof = qualifyingReport();
  const implementation = proof.identity.files["node_modules/undici/index.js"];
  assert.ok(implementation);
  implementation.path = "sibling/undici/index.js";
  assert.throws(() => assertNpmQualification(proof, "24.22.1"));
});
test("missing main full inventory never qualifies a release", () => {
  const { mainInventory: _omitted, ...missing } = qualifyingReport();
  assert.throws(() => assertNpmQualification(missing, "24.22.1"));
});
test("main inventory must exactly join the derived carrier inventory", () => {
  const proof = qualifyingReport();
  proof.mainInventory.bytes += 1;
  assert.throws(() => assertNpmQualification(proof, "24.22.1"));
});
test("owner reports cannot omit a selected file or its assertions", () => {
  const missing = ownerReport(OWNER_TEST_FILES);
  missing.testResults.pop();
  assert.throws(() => verifyOwnerTests(missing, OWNER_TEST_FILES));
  const empty = ownerReport(OWNER_TEST_FILES);
  const first = empty.testResults[0];
  assert.ok(first);
  first.assertionResults = [];
  assert.throws(() => verifyOwnerTests(empty, OWNER_TEST_FILES));
});
for (const status of ["failed", "pending", "skipped"]) {
  test(`official fixture ${status} cannot qualify`, () => {
    const report = ownerReport(OWNER_TEST_FILES);
    const assertion = report.testResults[0]?.assertionResults[0];
    assert.ok(assertion);
    assertion.status = status;
    assert.throws(() => verifyOwnerTests(report, OWNER_TEST_FILES));
  });
}
test("Linux retains the three explicit Windows skips without waiving other tests", () => {
  const report = ownerReport([LIFECYCLE_TEST_FILE]);
  const suite = report.testResults[0];
  assert.ok(suite);
  suite.assertionResults.push({
    title: "runs npm through the toolchain-local runner on Windows",
    status: "pending",
    failureMessages: [],
  });
  report.numPendingTests = 1;
  report.numTotalTests = 2;
  assert.equal(verifyOwnerTests(report, [LIFECYCLE_TEST_FILE]).platformSkipped, 1);
  const pending = suite.assertionResults[1];
  assert.ok(pending);
  pending.title = "unapproved skip";
  assert.throws(() => verifyOwnerTests(report, [LIFECYCLE_TEST_FILE]));
});
const corruptions: Array<[string, (proof: ReturnType<typeof qualifyingReport>) => void]> = [
  [
    "three-argument probe only",
    (proof) => {
      proof.qualificationEligible = false;
    },
  ],
  [
    "authentication after first command",
    (proof) => {
      proof.mainAuthentication.beforeFirstCommand = false;
    },
  ],
  [
    "main authenticated archive drift",
    (proof) => {
      proof.mainAuthentication.archiveSha256[2] = "c".repeat(64);
    },
  ],
  [
    "main full payload drift",
    (proof) => {
      proof.mainInventory.treeSha256 = "c".repeat(64);
    },
  ],
  [
    "not Linux",
    (proof) => {
      proof.platform = "darwin";
    },
  ],
  [
    "routable namespace",
    (proof) => {
      proof.network.interfaces.push("eth0");
    },
  ],
  [
    "missing consumer",
    (proof) => {
      proof.consumerCases.pop();
    },
  ],
  [
    "roundtrip requested but not passed",
    (proof) => {
      proof.carrierRoundtrip.passed = false;
    },
  ],
  [
    "rollback missing",
    (proof) => {
      proof.carrierRoundtrip.phases.pop();
    },
  ],
  [
    "rollback lock drift",
    (proof) => {
      const phase = proof.carrierRoundtrip.phases[2];
      assert.ok(phase);
      phase.lock.sha256 = "c".repeat(64);
    },
  ],
  [
    "rollback payload drift",
    (proof) => {
      const phase = proof.carrierRoundtrip.phases[2];
      assert.ok(phase);
      phase.inventory.treeSha256 = "c".repeat(64);
    },
  ],
  [
    "proxy bypass",
    (proof) => {
      const c = proof.consumerCases[1];
      assert.ok(c);
      c.transport.proxyConnects = 0;
    },
  ],
  [
    "unclean socket",
    (proof) => {
      const c = proof.consumerCases[0];
      assert.ok(c);
      c.cleanup.openBeforeCleanup = 1;
    },
  ],
  [
    "unjoined cancellation",
    (proof) => {
      const c = proof.consumerCases[5]?.commands[0];
      assert.ok(c);
      c.joined = false;
    },
  ],
  [
    "forced cancellation",
    (proof) => {
      const c = proof.consumerCases[5]?.commands[0];
      assert.ok(c);
      c.cancellationMs = 3500;
    },
  ],
  [
    "wrong checksum failure",
    (proof) => {
      const c = proof.consumerCases[4]?.commands[0];
      assert.ok(c);
      c.checksumRejected = false;
    },
  ],
  [
    "unsupported native compile claim",
    (proof) => {
      proof.nativeCompilationVerified = true;
    },
  ],
];
for (const [name, corrupt] of corruptions) {
  test(`aggregate rejects ${name}`, () => {
    const proof = qualifyingReport();
    corrupt(proof);
    assert.throws(() => assertNpmQualification(proof, "24.22.1"));
  });
}
