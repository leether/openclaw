import assert from "node:assert/strict";
import { BUNDLED_NPM_CONTRACT } from "../../lib/package-bundled-npm.mts";
import { CASES } from "./consumer-proof.mjs";
import { TARGET } from "./loopback.mjs";
import { OWNER_TEST_FILES, LIFECYCLE_TEST_FILE, verifyOwnerTests } from "./owner-test-contract.mjs";

export const NPM_ARTIFACT_NAMES = [
  "npm-owner-tests.json",
  "npm-pack-lifecycle-tests.json",
  "npm-original-12.2.1.tgz",
  "npm-undici-6.29.1.tgz",
  "npm-derived.tgz",
  "npm-derivation-provenance.json",
  ...["installed", "restored"].flatMap((prefix) =>
    ["24.22.1", "24.22.0"].map((version) => `${prefix}-npm-proof-${version}.json`),
  ),
];

const sha256 = (value) => assert.match(value, /^[a-f0-9]{64}$/);
const relative = (value) => {
  assert.equal(typeof value, "string");
  assert.ok(
    value &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
  );
};
function command(receipt, cancellation = false, status = 0) {
  assert.equal(receipt.closed, true);
  assert.equal(receipt.joined, true);
  assert.equal(receipt.processGroupState, "dead");
  assert.ok(Number.isSafeInteger(receipt.processGroupId) && receipt.processGroupId > 1);
  assert.ok(
    Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs >= 0 && receipt.elapsedMs < 30000,
  );
  assert.ok(
    Number.isSafeInteger(receipt.outputBytes) &&
      receipt.outputBytes >= 0 &&
      receipt.outputBytes <= 262144,
  );
  assert.equal(receipt.fault, null);
  sha256(receipt.stderrSha256);
  assert.equal(receipt.expectedCancellation, cancellation);
  if (cancellation) {
    assert.equal(receipt.errorCode, "ABORT_ERR");
    assert.ok(receipt.cancellationMs >= 0 && receipt.cancellationMs < 3500);
  } else {
    assert.equal(receipt.errorCode, null);
    assert.equal(receipt.status, status);
  }
}
function identity(proof, version) {
  const npmPath = proof.packages.npm.package;
  relative(npmPath);
  assert.ok(npmPath.endsWith("/package.json"));
  const npmPrefix = npmPath.slice(0, -"package.json".length);
  const normalized = { packages: {}, files: {} };
  for (const [name, expected] of [
    ["npm", "12.2.1"],
    ["node-gyp", "13.0.0"],
    ["undici", version],
  ]) {
    const item = proof.packages[name];
    assert.equal(item.version, expected);
    relative(item.package);
    sha256(item.sha256);
    const expectedPath = name === "npm" ? "package.json" : `node_modules/${name}/package.json`;
    assert.equal(item.package, npmPrefix + expectedPath);
    normalized.packages[name] = { ...item, package: expectedPath };
  }
  assert.deepEqual(
    Object.keys(proof.files).toSorted(),
    [
      "bin/npm-cli.js",
      "node_modules/node-gyp/bin/node-gyp.js",
      "node_modules/node-gyp/lib/download.js",
      "node_modules/node-gyp/lib/install.js",
      "node_modules/node-gyp/lib/process-release.js",
      "node_modules/undici/index.js",
    ].toSorted(),
  );
  for (const [key, item] of Object.entries(proof.files)) {
    relative(item.path);
    sha256(item.sha256);
    assert.equal(item.path, npmPrefix + key);
    normalized.files[key] = { ...item, path: key };
  }
  return normalized;
}
function consumer(proof, expectedName, parentIdentity) {
  assert.equal(proof.name, expectedName);
  assert.equal(proof.passed, true);
  assert.equal(proof.requestAbortSignalSupported, false);
  assert.deepEqual(proof.cleanup, { openBeforeCleanup: 0, openAfterCleanup: 0 });
  const cancellation = expectedName.startsWith("cancel-");
  assert.equal(proof.commands.length, expectedName === "direct-ensure" ? 2 : 1);
  command(proof.commands[0], cancellation, expectedName === "bad-checksum" ? 1 : 0);
  const events = proof.commands[0].events;
  assert.ok(Array.isArray(events) && events.length > 0 && events.length <= 32);
  assert.ok(events.some((event) => event.kind === "request" && event.transport === "origin"));
  const nonce = events[0].nonce;
  assert.match(nonce, /^[a-f0-9-]{36}$/);
  for (const event of events) {
    assert.equal(event.nonce, nonce);
    assert.ok(["request", "headers"].includes(event.kind));
    assert.ok(["origin", "proxy"].includes(event.transport));
    assert.equal(event.download, "node_modules/node-gyp/lib/download.js");
    assert.equal(event.undiciEntry, "node_modules/undici/index.js");
    assert.equal(event.undiciVersion, parentIdentity.packages.undici.version);
    assert.equal(event.undiciPackageSha256, parentIdentity.packages.undici.sha256);
    assert.ok(Number.isSafeInteger(event.pid) && event.pid > 1);
    if (event.transport === "proxy") {
      assert.equal(event.pathname, "CONNECT");
    } else {
      assert.ok(event.pathname.startsWith(`/${nonce}/v${TARGET}/`));
    }
  }
  const transport = proof.transport;
  assert.equal(transport.unexpected, null);
  assert.equal(transport.openSockets, 0);
  assert.ok(
    Number.isSafeInteger(transport.connections) &&
      transport.connections > 0 &&
      transport.connections <= 32,
  );
  assert.ok(
    Number.isSafeInteger(transport.sentBytes) &&
      transport.sentBytes >= 0 &&
      transport.sentBytes <= 1048576,
  );
  const paths =
    cancellation || expectedName === "destroy-returned-body"
      ? [`node-v${TARGET}-headers.tar.gz`]
      : [`node-v${TARGET}-headers.tar.gz`, "SHASUMS256.txt"];
  assert.deepEqual(
    transport.requests,
    paths.map((p) => ({ path: p, method: "GET" })),
  );
  if (["explicit-proxy", "environment-proxy"].includes(expectedName)) {
    assert.ok(
      Number.isSafeInteger(transport.proxyConnects) &&
        transport.proxyConnects > 0 &&
        transport.proxyConnects <= 16,
    );
    assert.ok(events.some((event) => event.transport === "proxy"));
  } else {
    assert.equal(transport.proxyConnects, 0);
  }
  if (cancellation) {
    assert.deepEqual(proof.cancellation, {
      mode: "owned-cli-process-group",
      heldRequestObserved: true,
      actualProcessesJoined: true,
      socketsClosed: true,
      callerAbortSignalForwardedToFetch: false,
      partialStateMayRemain: true,
    });
    assert.ok(
      Array.isArray(proof.remainingTemporaryNames) && proof.remainingTemporaryNames.length <= 32,
    );
  } else if (expectedName === "bad-checksum") {
    assert.equal(proof.commands[0].checksumRejected, true);
    assert.equal(proof.rollbackVerified, true);
  } else if (expectedName === "destroy-returned-body") {
    assert.equal(proof.returnedBodyDestroyVerified, true);
  } else {
    assert.deepEqual(Object.keys(proof.headerSha256).toSorted(), [
      "include/node/fixture.gypi",
      "include/node/fixture.h",
    ]);
    for (const value of Object.values(proof.headerSha256)) {
      sha256(value);
    }
    if (expectedName === "direct-ensure") {
      command(proof.commands[1]);
      assert.deepEqual(proof.commands[1].events, []);
      assert.equal(proof.ensureAvoidedDownload, true);
    }
  }
}
export function assertNpmQualification(proof, version) {
  assert.equal(proof.protocol, "npm-node-gyp-consumer-v1");
  assert.equal(proof.passed, true);
  assert.equal(proof.node, `v${version}`);
  assert.equal(proof.platform, "linux");
  assert.equal(proof.syntheticOnly, true);
  assert.equal(proof.nativeCompilationVerified, false);
  assert.equal(proof.requestAbortSignalSupported, false);
  assert.equal(proof.containment, "outer-linux-qualification-scope-required");
  assert.equal(proof.network.platform, "linux");
  assert.deepEqual(proof.network.interfaces, ["lo"]);
  assert.equal(proof.network.externallyRoutedInterfacePresent, false);
  assert.match(proof.network.namespace, /^net:\[[0-9]+\]$/);
  assert.equal(proof.version, "12.2.1");
  assert.deepEqual(proof.bundled, {
    "brace-expansion": "5.0.12",
    "http-cache-semantics": "4.3.0",
    undici: "6.29.1",
  });
  assert.deepEqual(
    proof.phases,
    ["1.0.0", "1.0.1", "1.0.0"].map((v) => ({ version: v, installScriptSuppressed: true })),
  );
  assert.equal(proof.commands.length, 6);
  for (const receipt of proof.commands) {
    command(receipt);
  }
  const mainIdentity = identity(proof.identity, "6.29.1");
  assert.equal(proof.qualificationEligible, true);
  assert.equal(proof.mainInventory.files, BUNDLED_NPM_CONTRACT.derivedFiles);
  assert.ok(proof.mainInventory.bytes > 0 && proof.mainInventory.bytes <= 16 * 1024 * 1024);
  assert.equal(proof.mainInventory.treeSha256, BUNDLED_NPM_CONTRACT.derivedTreeSha256);
  assert.equal(proof.mainAuthentication.beforeFirstCommand, true);
  assert.deepEqual(
    proof.consumerCases.map((c) => c.name),
    CASES,
  );
  for (const [index, name] of CASES.entries()) {
    consumer(proof.consumerCases[index], name, proof.identity);
  }
  const carrier = proof.carrierRoundtrip;
  assert.equal(carrier.requested, true);
  assert.equal(carrier.passed, true);
  assert.deepEqual(carrier.officialInputs, {
    npmIntegrity: BUNDLED_NPM_CONTRACT.npmIntegrity,
    undiciIntegrity: BUNDLED_NPM_CONTRACT.undiciIntegrity,
  });
  assert.equal(carrier.derivedTreeSha256, BUNDLED_NPM_CONTRACT.derivedTreeSha256);
  assert.match(carrier.derivedArchiveIntegrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(carrier.archiveSha256.length, 3);
  carrier.archiveSha256.forEach(sha256);
  assert.deepEqual(proof.mainAuthentication, {
    officialInputs: carrier.officialInputs,
    derivedTreeSha256: carrier.derivedTreeSha256,
    derivedArchiveIntegrity: carrier.derivedArchiveIntegrity,
    archiveSha256: carrier.archiveSha256,
    beforeFirstCommand: true,
  });
  assert.deepEqual(
    carrier.phases.map((p) => p.stage),
    ["official-before", "derived", "official-rollback"],
  );
  for (const [index, phase] of carrier.phases.entries()) {
    assert.equal(phase.passed, true);
    command(phase.install);
    const expectedVersion = index === 1 ? "6.29.1" : "6.29.0";
    const phaseIdentity = identity(phase.identity, expectedVersion);
    assert.equal(
      phase.inventory.files,
      index === 1 ? BUNDLED_NPM_CONTRACT.derivedFiles : BUNDLED_NPM_CONTRACT.originalFiles,
    );
    assert.ok(phase.inventory.bytes > 0 && phase.inventory.bytes <= 16 * 1024 * 1024);
    sha256(phase.inventory.treeSha256);
    sha256(phase.lock.sha256);
    assert.ok(phase.lock.bytes > 0 && phase.lock.bytes <= 262144);
    assert.equal(phase.lock.lockfileVersion, 3);
    assert.equal(phase.lock.npmVersion, "12.2.1");
    assert.equal(phase.lock.nodeGypVersion, "13.0.0");
    assert.equal(phase.lock.undiciVersion, expectedVersion);
    assert.equal(phase.lock.nodeGypInBundle, true);
    assert.equal(phase.lock.undiciInBundle, true);
    assert.match(phase.lock.npmIntegrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    if (index !== 1) {
      assert.equal(phase.lock.npmIntegrity, BUNDLED_NPM_CONTRACT.npmIntegrity);
    } else {
      assert.deepEqual(phase.inventory, proof.mainInventory);
      assert.deepEqual(phaseIdentity, mainIdentity, "main consumer differs from derived carrier");
      assert.equal(phase.inventory.treeSha256, BUNDLED_NPM_CONTRACT.derivedTreeSha256);
      assert.equal(phase.lock.npmIntegrity, carrier.derivedArchiveIntegrity);
    }
    consumer(phase.consumer, "direct-ensure", phase.identity);
  }
  assert.equal(carrier.phases[0].inventory.treeSha256, carrier.phases[2].inventory.treeSha256);
  assert.equal(carrier.phases[0].lock.sha256, carrier.phases[2].lock.sha256);
  assert.deepEqual(carrier.phases[0].identity, carrier.phases[2].identity);
}

// The caller supplies bounded artifact IO. All four cells are mandatory; local
// fixture tests, requested-but-not-run roundtrips and other Node versions refuse.
export async function collectNpmQualification(read, hashFile) {
  const result = {
    protocol: "npm-node-gyp-consumer-v1",
    passed: true,
    cells: {},
    artifactNames: NPM_ARTIFACT_NAMES,
    ownerTests: verifyOwnerTests(await read("npm-owner-tests.json"), OWNER_TEST_FILES),
    lifecycleTests: verifyOwnerTests(await read("npm-pack-lifecycle-tests.json"), [
      LIFECYCLE_TEST_FILE,
    ]),
    artifactHashes: {},
  };
  for (const filename of NPM_ARTIFACT_NAMES) {
    const fileSha256 = await hashFile(filename);
    sha256(fileSha256);
    result.artifactHashes[filename] = fileSha256;
  }
  const expectedArchiveHashes = [
    "npm-original-12.2.1.tgz",
    "npm-undici-6.29.1.tgz",
    "npm-derived.tgz",
  ].map((filename) => result.artifactHashes[filename]);
  const provenance = await read("npm-derivation-provenance.json");
  assert.equal(provenance.contract, BUNDLED_NPM_CONTRACT.version);
  assert.equal(provenance.derivedTreeSha256, BUNDLED_NPM_CONTRACT.derivedTreeSha256);
  assert.equal(
    provenance.unchangedOutsideUndiciCount,
    BUNDLED_NPM_CONTRACT.unchangedOutsideUndiciFiles,
  );
  assert.equal(provenance.files.length, BUNDLED_NPM_CONTRACT.derivedFiles);
  let first;
  for (const prefix of ["installed", "restored"]) {
    for (const version of ["24.22.1", "24.22.0"]) {
      const filename = `${prefix}-npm-proof-${version}.json`;
      const proof = await read(filename);
      assertNpmQualification(proof, version);
      assert.deepEqual(proof.carrierRoundtrip.archiveSha256, expectedArchiveHashes);
      assert.deepEqual(proof.carrierRoundtrip.officialInputs, provenance.officialInputs);
      if (first) {
        assert.deepEqual(proof.identity, first.identity);
        assert.deepEqual(proof.mainInventory, first.mainInventory);
        assert.deepEqual(proof.mainAuthentication, first.mainAuthentication);
        assert.deepEqual(
          proof.carrierRoundtrip.archiveSha256,
          first.carrierRoundtrip.archiveSha256,
        );
        assert.equal(
          proof.carrierRoundtrip.derivedArchiveIntegrity,
          first.carrierRoundtrip.derivedArchiveIntegrity,
        );
        assert.deepEqual(
          proof.carrierRoundtrip.phases.map((p) => p.inventory),
          first.carrierRoundtrip.phases.map((p) => p.inventory),
        );
      } else {
        first = proof;
      }
      const fileSha256 = result.artifactHashes[filename];
      result.cells[`${prefix}-${version}`] = {
        reportSha256: fileSha256,
        passed: true,
        cases: CASES.length,
        carrierPhases: 3,
        mainInventory: proof.mainInventory,
        mainIdentityMatchesDerivedCarrier: true,
        nativeCompilationVerified: false,
      };
    }
  }
  return result;
}
