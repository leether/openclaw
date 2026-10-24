import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export async function runBounded(args, cwd, { timeoutMs = 30000, maxBytes = 262144 } = {}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 262144);
  const start = performance.now();
  const deadlineNs = process.hrtime.bigint() + BigInt(timeoutMs) * 1000000n;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--max-old-space-size=512", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        LANG: "C",
        TZ: "UTC",
        OPENCLAW_MSAL_SCENARIO_DEADLINE_NS: deadlineNs.toString(),
      },
    });
    const stdout = [];
    const stderrHash = createHash("sha256");
    let count = 0;
    let failure = null;
    const fail = (reason) => {
      failure ??= reason;
      child.kill("SIGKILL");
    };
    const remainingMs = Number((deadlineNs - process.hrtime.bigint()) / 1000000n);
    const timer = setTimeout(() => fail("wall-limit"), Math.max(0, remainingMs));
    function collect(data, output) {
      count += data.length;
      if (!output) {
        stderrHash.update(data);
      }
      if (count > maxBytes) {
        fail("output-limit");
        return;
      }
      if (output && !failure) {
        stdout.push(data);
      }
    }
    child.stdout.on("data", (data) => collect(data, true));
    child.stderr.on("data", (data) => collect(data, false));
    child.on("error", () => {
      failure ??= "spawn-error";
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      let proof = null;
      if (!failure && exitCode === 0) {
        try {
          proof = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        } catch {
          failure = "invalid-json";
        }
      }
      resolve({
        passed: !failure && exitCode === 0,
        exitCode,
        signal,
        failure,
        elapsedMs: Math.round(performance.now() - start),
        outputBytes: count,
        stderrSha256: stderrHash.digest("hex"),
        closed: true,
        proof,
      });
    });
  });
}
