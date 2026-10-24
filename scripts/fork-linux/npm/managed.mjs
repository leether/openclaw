import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  runManagedCommand,
} from "../../lib/managed-child-process.mts";

export const OUTPUT_LIMIT = 262144;
const CANCEL_GRACE_MS = 3500;

// Reuse the repository process-tree owner. Killing only npm's PID leaves its
// lifecycle shell/node-gyp descendants outside the proof's terminal boundary.
/**
 * @param {{runtime: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
 * signal?: AbortSignal, expectCancellation?: boolean,
 * onEvent?: (event: Record<string, unknown>) => void,
 * owner?: typeof runManagedCommand, inspect?: typeof inspectManagedProcessGroup}} options
 */
export async function managedCommand({
  runtime,
  args,
  cwd,
  env,
  signal,
  expectCancellation = false,
  onEvent = () => {},
  owner = runManagedCommand,
  inspect = inspectManagedProcessGroup,
}) {
  const controller = new AbortController();
  let abortedAt = null;
  const abort = () => {
    abortedAt ??= performance.now();
    controller.abort(signal?.reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  const started = performance.now();
  let child;
  let closed = false;
  let bytes = 0;
  let stdout = "";
  let stderrLine = "";
  let fault = null;
  let status = null;
  let caught;
  const stderrHash = createHash("sha256");
  const fail = (reason) => {
    fault ??= reason;
    controller.abort(new Error(reason));
  };
  const events = [];
  let checksumRejected = false;
  try {
    status = await owner({
      bin: runtime,
      args: ["--max-old-space-size=512", ...args],
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: 25000,
      timeoutKillGraceMs: 1000,
      abortKillGraceMs: CANCEL_GRACE_MS,
      signalKillGraceMs: 1000,
      cleanupDrainTimeoutMs: 1000,
      requireProcessTreeExit: true,
      signal: controller.signal,
      onReady(value) {
        child = value;
        child.once("close", () => {
          closed = true;
        });
        assert.ok(child.stdout && child.stderr, "managed pipes missing");
        child.stdout.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > OUTPUT_LIMIT) {
            return fail("output-limit");
          }
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
          bytes += chunk.length;
          stderrHash.update(chunk);
          if (bytes > OUTPUT_LIMIT) {
            return fail("output-limit");
          }
          stderrLine += chunk.toString("utf8");
          if (stderrLine.length > OUTPUT_LIMIT) {
            return fail("line-limit");
          }
          let newline;
          while ((newline = stderrLine.indexOf("\n")) !== -1) {
            const line = stderrLine.slice(0, newline);
            stderrLine = stderrLine.slice(newline + 1);
            if (
              /node-v[0-9.]+-headers\.tar\.gz local checksum [a-f0-9]{64} not match remote [a-f0-9]{64}/.test(
                line,
              )
            ) {
              checksumRejected = true;
            }
            if (!line.startsWith("NPM_CONSUMER_EVENT ")) {
              continue;
            }
            try {
              assert.ok(line.length < 8192 && events.length < 32, "event limit");
              const event = JSON.parse(line.slice("NPM_CONSUMER_EVENT ".length));
              events.push(event);
              onEvent(event);
            } catch {
              fail("invalid-consumer-event");
            }
          }
        });
      },
    });
  } catch (error) {
    caught = error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  const groupState = child
    ? inspect(child, { errorPolicy: "indeterminate", deadlineAt: Date.now() + 1000 })
    : "indeterminate";
  const elapsedMs = Math.round(performance.now() - started);
  const cancellationMs = abortedAt === null ? null : performance.now() - abortedAt;
  const joined = closed && groupState === "dead" && !hasUnjoinedWork(caught);
  const errorCode = caught && typeof caught === "object" ? caught.code : null;
  const receipt = {
    status,
    signal: child?.signalCode ?? null,
    errorCode: errorCode ?? null,
    closed,
    processGroupId: child?.pid ?? null,
    processGroupState: groupState,
    joined,
    elapsedMs,
    outputBytes: bytes,
    stderrSha256: stderrHash.digest("hex"),
    cancellationMs,
    expectedCancellation: expectCancellation,
    checksumRejected,
    fault,
  };
  assert.ok(
    joined && !fault && elapsedMs < 30000,
    `managed npm consumer did not terminate: ${JSON.stringify(receipt)}`,
  );
  if (expectCancellation) {
    assert.equal(errorCode, "ABORT_ERR");
    assert.ok(
      signal?.aborted && cancellationMs !== null && cancellationMs < CANCEL_GRACE_MS,
      "cancellation required forced escalation or did not originate in the fixture",
    );
  } else if (caught) {
    throw Object.assign(new Error(`managed npm command failed: ${errorCode ?? "unknown"}`), {
      receipt,
    });
  }
  return { ...receipt, stdout, events };
}
