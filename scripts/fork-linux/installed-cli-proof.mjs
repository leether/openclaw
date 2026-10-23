// Actual installed CLI entry, with the same single-process startup environment
// as a bounded metadata caller. This does not import or certify an external caller.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

export async function assertReadyInstall(packageRoot) {
  const absent = [".openclaw-lifecycle-pending", "dist/openclaw-install-guard"];
  for (const name of absent) {
    await assert.rejects(fs.lstat(path.join(packageRoot, name)), { code: "ENOENT" });
  }
  return { absent };
}

function deadline(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function qualifyMetadataCli({ own, metadataHolds }) {
  const operations = [];
  const args = (method, params) => [
    "--no-color",
    "gateway",
    "call",
    method,
    "--timeout",
    "15000",
    "--params",
    JSON.stringify(params),
    "--json",
  ];
  async function execute(method, params, hold, { cancelAtAdmission = false, record = true } = {}) {
    const started = performance.now();
    const child = own(args(method, params));
    assert.ok(Number.isInteger(child.pid));
    const pid = child.pid;
    let stdout = "",
      stderr = "",
      reason,
      stoppedAt,
      admissionMs;
    const stop = (why) => {
      if (reason) {
        return;
      }
      reason = why;
      stoppedAt = performance.now();
      child.kill("SIGKILL");
    };
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    // Attach before awaiting a server barrier so an early CLI exit is observed.
    const terminal = closed.then(
      (value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 256 * 1024) {
        stop("output-limit");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 8 * 1024) {
        stop("output-limit");
      }
    });
    const timer = setTimeout(
      () => stop("timeout"),
      Math.max(0, 5000 - (performance.now() - started)),
    );
    try {
      let childrenAtAdmission = [];
      if (hold) {
        await deadline(
          Promise.race([
            hold.admitted,
            terminal.then(() => {
              throw new Error("CLI exited before metadata admission");
            }),
          ]),
          5000,
          "metadata admission exceeded parent deadline",
        );
        admissionMs = performance.now() - started;
        const children = await fs.readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
        childrenAtAdmission = children.trim().split(/\s+/).filter(Boolean);
        assert.deepEqual(childrenAtAdmission, [], "metadata CLI must own its single PID");
        if (cancelAtAdmission) {
          stop("cancelled");
        }
      }
      const result = await deadline(
        terminal,
        Math.max(1, 7000 - (performance.now() - started)),
        "owned CLI pipes did not close",
      );
      if (result.error) {
        throw result.error;
      }
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      let executionDrain;
      if (!hold) {
        assert.equal(reason, undefined, stderr.slice(-3000));
        assert.equal(result.value.code, 0, stderr.slice(-3000));
        const status = JSON.parse(stdout);
        assert.equal(status.timerBudget?.protocol, "timer-budget-v1");
        assert.equal(status.executionDrain?.protocol, "tool-drain-v1");
        executionDrain = status.executionDrain;
        assert.ok(
          performance.now() - started < 5000,
          "metadata CLI close and JSON validation must fit the parent 5s budget",
        );
      } else {
        assert.equal(reason, cancelAtAdmission ? "cancelled" : "timeout");
        assert.equal(result.value.signal, "SIGKILL");
        assert.ok(admissionMs < 5000);
        assert.ok(
          performance.now() - stoppedAt < 2000,
          "cancellation cleanup is separately bounded",
        );
      }
      const operation = {
        method,
        pid,
        elapsedMs: performance.now() - started,
        admissionMs,
        reason: reason ?? "success",
        code: result.value.code,
        signal: result.value.signal,
        parentDeadlineMs: 5000,
        cleanupElapsedMs: stoppedAt ? performance.now() - stoppedAt : 0,
        pidExited: true,
        pipesClosed: true,
        childrenAtAdmission,
        executionDrain,
      };
      if (record) {
        operations.push(operation);
      }
      return operation;
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        stop("proof-cleanup");
        await deadline(terminal, 2000, "metadata cleanup failed");
      }
    }
  }
  await execute("status", { includeChannelSummary: false });
  for (const mode of ["cancelled", "timeout"]) {
    const admission = deferred();
    const settlement = deferred();
    const nonce = `metadata-${mode}`;
    const hold = {
      admitted: admission.promise,
      settled: settlement.promise,
      admit: admission.resolve,
      settle: settlement.resolve,
      release: undefined,
    };
    metadataHolds.set(nonce, hold);
    let operation;
    try {
      operation = await execute("timer-fixture.metadataHold", { nonce }, hold, {
        cancelAtAdmission: mode === "cancelled",
      });
    } finally {
      // Client close never stands in for server completion. Release and join the
      // synthetic read-only handler independently before the next operation.
      if (hold.release) {
        hold.release();
        await deadline(hold.settled, 5000, "synthetic metadata handler did not settle");
        if (operation) {
          // The notification precedes the handler's last awaited response body.
          // The native owner must also prove its retained root work has ended.
          const settled = await execute("status", { includeChannelSummary: false }, undefined, {
            record: false,
          });
          assert.equal(settled.executionDrain.idle, true);
          assert.equal(settled.executionDrain.counts.totalActive, 0);
          operation.handlerDrain = settled.executionDrain;
          operation.handlerSettled = true;
        }
      }
      metadataHolds.delete(nonce);
    }
  }
  return {
    passed: true,
    coldMeaning: "fresh CLI process with compile cache disabled; not a cold OS page cache",
    scope: "actual installed CLI and matching startup environment; not external adapter E2E",
    operations,
  };
}
