import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer, createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  createBrowserTemporaryDirectory,
  verifyBrowserTemporaryPath,
  createBrowserOutputBudget,
  finalizeBrowserOutput,
} from "../../scripts/fork-linux/canvas-browser.mjs";
import {
  LIMIT,
  verifyKernelReceipts,
  parseScopeState,
} from "../../scripts/fork-linux/canvas-managed.mjs";
import {
  fileHash,
  ownedFile,
  verifyFiles,
  exerciseRegisteredPlugin,
} from "../../scripts/fork-linux/canvas-runtime.mjs";
import {
  verifySandboxStatus,
  parseRendererStatus,
} from "../../scripts/fork-linux/canvas-sandbox.mjs";

function fixture(fn: (root: string) => unknown) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-proof-pure-")));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test("exact captured closure accepts unchanged regular bytes", () =>
  fixture((root) => {
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist/test.js"), "export default 1;\n");
    const expected = { "dist/test.js": fileHash(ownedFile(root, "dist/test.js")) };
    verifyFiles(root, expected);
  }));
test("changed installed closure is rejected", () =>
  fixture((root) => {
    fs.mkdirSync(path.join(root, "dist"));
    const file = path.join(root, "dist/test.js");
    fs.writeFileSync(file, "export default 1;\n");
    const expected = { "dist/test.js": fileHash(file) };
    fs.writeFileSync(file, "export default 2;\n");
    assert.throws(() => verifyFiles(root, expected), /Changed closure file/u);
  }));
test("package escape and symlink component are rejected", () =>
  fixture((root) => {
    fs.mkdirSync(path.join(root, "actual"));
    fs.writeFileSync(path.join(root, "actual/test.js"), "x");
    fs.symlinkSync(path.join(root, "actual"), path.join(root, "dist"));
    assert.throws(() => ownedFile(root, "../outside.js"));
    assert.throws(() => ownedFile(root, "dist/test.js"), /Symlink component/u);
  }));
test("empty or non-dist closure cannot qualify", () =>
  fixture((root) => {
    assert.throws(() => verifyFiles(root, {}));
    assert.throws(() => verifyFiles(root, { "package.json": { sha256: "x", bytes: 1 } }));
  }));
test("unregistered or wrong plugin cannot masquerade as a passed runtime", () => {
  assert.throws(() => exerciseRegisteredPlugin({ id: "wrong", register() {} }));
  assert.throws(
    () => exerciseRegisteredPlugin({ id: "canvas", register() {} }),
    /registerBoardWidgetContentKind/u,
  );
});
test("an async replacement registration is not silently accepted", () => {
  assert.throws(
    () => exerciseRegisteredPlugin({ id: "canvas", register: async () => {} }),
    /synchronous/u,
  );
});
const unit = "openclaw-check-synthetic.scope";
const kernel = {
  cgroup: `/user.slice/${unit}`,
  device: "31",
  inode: "9001",
  max: String(LIMIT),
  swapMax: "0",
  events: { max: 0, oom: 0, oom_kill: 0 },
  peak: 512 * 1024 ** 2,
};
test("matching owned kernel receipts remain within the fixed limit", () => {
  verifyKernelReceipts(kernel, structuredClone(kernel), unit);
});
const kernelChanges: Array<[string, Partial<typeof kernel>]> = [
  ["different-owner", { cgroup: "/user.slice/openclaw-check-other.scope" }],
  ["recreated-cgroup", { inode: "9002" }],
  ["larger-memory-limit", { max: String(LIMIT * 2) }],
  ["enabled-swap", { swapMax: "max" }],
  ["over-limit-peak", { peak: LIMIT + 1 }],
  ["limit-hit", { events: { max: 1, oom: 0, oom_kill: 0 } }],
  ["oom", { events: { max: 0, oom: 1, oom_kill: 1 } }],
];
for (const [name, change] of kernelChanges) {
  test(`kernel ${name} cannot qualify`, () => {
    assert.throws(() =>
      verifyKernelReceipts(kernel, { ...structuredClone(kernel), ...change }, unit),
    );
  });
}

test("optional group OOM counter must remain zero and present consistently", () => {
  const withGroup = { ...structuredClone(kernel), events: { ...kernel.events, oom_group_kill: 0 } };
  verifyKernelReceipts(withGroup, structuredClone(withGroup), unit);
  assert.throws(() =>
    verifyKernelReceipts(
      withGroup,
      { ...withGroup, events: { ...withGroup.events, oom_group_kill: 1 } },
      unit,
    ),
  );
  assert.throws(() => verifyKernelReceipts(withGroup, kernel, unit));
});
for (const status of [0, 1]) {
  test(`not-found scope accepts only complete inactive receipt (exit ${status})`, () => {
    assert.equal(
      parseScopeState({
        status,
        stdout: "LoadState=not-found\nActiveState=inactive\nControlGroup=\n",
      }).LoadState,
      "not-found",
    );
  });
}
test("systemctl timeout, abnormal status, missing or conflicting fields cannot qualify", () => {
  const stdout = "LoadState=not-found\nActiveState=inactive\nControlGroup=\n";
  for (const change of [
    { status: 2 },
    { signal: "SIGKILL" },
    { error: new Error("timeout") },
    { stdout: "LoadState=not-found\n" },
    { stdout: stdout + "LoadState=loaded\n" },
    { stdout: stdout.replace("inactive", "active") },
    { stdout: stdout.replace("ControlGroup=", "ControlGroup=/other") },
    { status: 1, stdout: "LoadState=loaded\nActiveState=inactive\nControlGroup=/owned\n" },
  ]) {
    assert.throws(() => parseScopeState({ status: 0, stdout, ...change }));
  }
  assert.equal(
    parseScopeState({
      status: 0,
      stdout: "LoadState=loaded\nActiveState=inactive\nControlGroup=/owned\n",
    }).ControlGroup,
    "/owned",
  );
});
test("combined browser output cap remains a failure after admission and last passing case", () => {
  const budget = createBrowserOutputBudget();
  assert.equal(budget.observe(Buffer.alloc(16384)), true); // stdout
  assert.equal(budget.observe(Buffer.alloc(16384)), true); // stderr at exact cap
  const report: {
    passed: boolean;
    browserOutput?: { bytes: number; limitBytes: number; limitExceeded: boolean };
  } = { passed: true };
  finalizeBrowserOutput(report, budget);
  assert.equal(report.passed, true);
  assert.equal(budget.observe(Buffer.alloc(1)), false); // late data, admission promise already resolved
  finalizeBrowserOutput(report, budget);
  assert.equal(report.passed, false);
  assert.deepEqual(report.browserOutput, { bytes: 32769, limitBytes: 32768, limitExceeded: true });
  assert.equal(budget.observe(Buffer.alloc(0)), false);
  report.passed = true;
  finalizeBrowserOutput(report, budget);
  assert.equal(report.passed, false);
});

const sandboxStatus = {
  suid: false,
  userNs: true,
  pidNs: true,
  netNs: true,
  seccompBpf: true,
  seccompTsync: true,
  sandboxGood: true,
};
test("actual Chromium namespace and seccomp status must all be positive", () => {
  verifySandboxStatus(sandboxStatus);
  for (const key of Object.keys(sandboxStatus)) {
    assert.throws(() =>
      verifySandboxStatus({
        ...sandboxStatus,
        [key]: !sandboxStatus[key as keyof typeof sandboxStatus],
      }),
    );
    const missing = { ...sandboxStatus };
    delete (missing as Record<string, unknown>)[key];
    assert.throws(() => verifySandboxStatus(missing));
  }
});
test("actual renderer requires seccomp filtering and no-new-privileges", () => {
  assert.deepEqual(parseRendererStatus("Name:\trenderer\nSeccomp:\t2\nNoNewPrivs:\t1\n"), {
    seccomp: 2,
    noNewPrivs: 1,
  });
  for (const text of [
    "",
    "Seccomp: 2",
    "Seccomp: 0\nNoNewPrivs: 1",
    "Seccomp: 2\nNoNewPrivs: 0",
    "Seccomp: 2\nSeccomp: 2\nNoNewPrivs: 1",
  ]) {
    assert.throws(() => parseRendererStatus(text));
  }
});
test("privileged prerequisite owner keeps failure, cancellation and repeat cleanup safe", () => {
  const result = execFileSync(
    "python3",
    ["test/scripts/fixtures/canvas-sandbox-owner.py", "scripts/fork-linux/canvas-sandbox.py"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 65536,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  assert.deepEqual(JSON.parse(result.trim().split("\n").at(-1)!), {
    passed: true,
    tests: 15,
    failures: 0,
    errors: 0,
  });
});

test("Chromium singleton path rejects long hosted evidence paths and counts UTF-8 bytes", () => {
  assert.throws(() => verifyBrowserTemporaryPath("relative"));
  assert.throws(() => verifyBrowserTemporaryPath("/tmp/invalid\0"));
  assert.throws(
    () =>
      verifyBrowserTemporaryPath(
        "/home/runner/work/openclaw/openclaw/.artifacts/fork-linux-package/canvas-sandbox-preflight/state/installed-restored-canvas",
      ),
    /103 bytes/u,
  );
  assert.throws(() => verifyBrowserTemporaryPath("/tmp/" + "界".repeat(30)), /103 bytes/u);
});
test("private short Chromium TMPDIR admits an actual singleton Unix socket", async () => {
  const directory = await createBrowserTemporaryDirectory();
  const socket = verifyBrowserTemporaryPath(directory.path);
  assert.equal(directory.mode, 0o700);
  assert.equal(directory.uid, process.getuid());
  fs.mkdirSync(path.dirname(socket), { mode: 0o700 });
  const server = createServer((connection) => connection.end("synthetic-socket-ok"));
  let client;
  try {
    server.listen(socket);
    await once(server, "listening");
    client = createConnection(socket);
    client.setEncoding("utf8");
    let received = "";
    client.on("data", (chunk) => {
      received += String(chunk);
    });
    await once(client, "close");
    assert.equal(received, "synthetic-socket-ok");
  } finally {
    client?.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(directory.path, { recursive: true, force: true });
  }
});
