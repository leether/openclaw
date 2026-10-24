// Thin evidence adapter over OpenClaw's existing managed Linux cgroup owner.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileHash, ownedFile } from "./canvas-runtime.mjs";

export const LIMIT = 1024 ** 3;
export const WORKER_TIMEOUT_MS = 20000;
function counters(text) {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const [key, raw] = line.split(/\s+/u);
        const value = Number(raw);
        assert.ok(Number.isSafeInteger(value) && value >= 0);
        return [key, value];
      }),
  );
}
function kernelSnapshot() {
  const line = fs
    .readFileSync("/proc/self/cgroup", "utf8")
    .trim()
    .split("\n")
    .find((value) => value.startsWith("0::"));
  assert.ok(line, "cgroup v2 is required");
  const cgroup = line.slice(3);
  assert.ok(cgroup.startsWith("/") && !cgroup.split("/").includes(".."));
  assert.match(cgroup, /\/openclaw-check-[a-f0-9-]+\.scope$/u);
  const directory = `/sys/fs/cgroup${cgroup}`;
  assert.equal(fs.statfsSync(directory).type, 0x63677270, "cgroup2 filesystem required");
  const stat = fs.statSync(directory, { bigint: true });
  const read = (name) => fs.readFileSync(path.join(directory, name), "utf8").trim();
  const result = {
    cgroup,
    device: String(stat.dev),
    inode: String(stat.ino),
    max: read("memory.max"),
    swapMax: read("memory.swap.max"),
    events: counters(read("memory.events.local")),
    peak: Number(read("memory.peak")),
  };
  assert.equal(result.max, String(LIMIT));
  assert.equal(result.swapMax, "0");
  assert.ok(Number.isSafeInteger(result.peak) && result.peak <= LIMIT);
  return result;
}
export function verifyKernelReceipts(before, after, unit) {
  assert.ok(unit && before.cgroup.endsWith(`/${unit}`));
  for (const key of ["cgroup", "device", "inode"]) {
    assert.equal(after[key], before[key], key);
  }
  for (const sample of [before, after]) {
    assert.equal(sample.max, String(LIMIT));
    assert.equal(sample.swapMax, "0");
    assert.ok(Number.isSafeInteger(sample.peak) && sample.peak >= 0 && sample.peak <= LIMIT);
    for (const key of ["max", "oom", "oom_kill"]) {
      assert.equal(sample.events[key], 0, key);
    }
    if ("oom_group_kill" in sample.events) {
      assert.equal(sample.events.oom_group_kill, 0, "oom_group_kill");
    }
  }
  assert.equal("oom_group_kill" in after.events, "oom_group_kill" in before.events);
}
export function parseScopeState(result) {
  assert.ok(!result.error && !result.signal, "systemctl query must finish normally");
  assert.ok([0, 1].includes(result.status), "Unexpected systemctl status");
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of result.stdout.trim().split("\n")) {
    const match = /^(LoadState|ActiveState|ControlGroup)=(.*)$/u.exec(line);
    assert.ok(match && !(match[1] in fields), "Unexpected or duplicate systemctl property");
    fields[match[1]] = match[2];
  }
  assert.deepEqual(Object.keys(fields).toSorted(), ["ActiveState", "ControlGroup", "LoadState"]);
  assert.equal(fields.ActiveState, "inactive");
  if (fields.LoadState === "not-found") {
    assert.equal(fields.ControlGroup, "");
  } else {
    assert.equal(result.status, 0);
    assert.equal(fields.LoadState, "loaded");
    assert.ok(fields.ControlGroup.startsWith("/"));
  }
  return fields;
}
function emptyScope(unit, before) {
  const result = spawnSync(
    "systemctl",
    [
      "--user",
      "show",
      "--property=LoadState",
      "--property=ActiveState",
      "--property=ControlGroup",
      unit,
    ],
    { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL", maxBuffer: 8192 },
  );
  const fields = parseScopeState(result);
  const directory = `/sys/fs/cgroup${before.cgroup}`;
  if (fields.LoadState === "not-found") {
    assert.equal(fs.existsSync(directory), false);
    return {
      empty: true,
      unitRemoved: true,
      systemctlStatus: result.status,
      finalUnitState: fields,
    };
  }
  assert.equal(fields.ControlGroup, before.cgroup);
  const stat = fs.statSync(directory, { bigint: true });
  assert.equal(String(stat.dev), before.device);
  assert.equal(String(stat.ino), before.inode);
  assert.match(fs.readFileSync(path.join(directory, "cgroup.events"), "utf8"), /^populated 0$/mu);
  return {
    empty: true,
    unitRemoved: false,
    systemctlStatus: result.status,
    finalUnitState: fields,
  };
}
export async function runBrowserWorker(values, nonce, callback) {
  const proofDir = values[4];
  const owner = JSON.parse(
    fs.readFileSync(ownedFile(fs.realpathSync(proofDir), "owner.json"), "utf8"),
  );
  assert.equal(owner.nonce, nonce);
  const before = kernelSnapshot();
  let report;
  try {
    report = await callback(...values);
  } catch (error) {
    report = {
      schemaVersion: 1,
      phase: "browser",
      passed: false,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      error: String(error.message).slice(0, 2000),
    };
  }
  const after = kernelSnapshot();
  report.workerContainment = { nonce, before, after };
  // This is intentionally not the final report: the worker is still in the scope.
  fs.writeFileSync(
    path.join(proofDir, "unqualified-browser.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx" },
  );
  return report;
}
export async function runManagedBrowser(values, script, mode = "browser") {
  assert.ok(["browser", "sandbox"].includes(mode));
  const begin = performance.now();
  const sourceArg = values[2];
  const proofDir = values[4];
  assert.ok(path.isAbsolute(sourceArg) && path.isAbsolute(proofDir));
  const source = fs.realpathSync(sourceArg);
  assert.equal(
    JSON.parse(fs.readFileSync(ownedFile(source, "package.json"), "utf8")).name,
    "openclaw",
  );
  const ownerPath = ownedFile(source, "scripts/lib/managed-child-process.mts");
  const { runManagedCommand, hasUnjoinedWork } = await import(pathToFileURL(ownerPath));
  fs.mkdirSync(proofDir); // Refuse existing paths before any evidence write.
  const nonce = randomUUID();
  fs.writeFileSync(path.join(proofDir, "owner.json"), `${JSON.stringify({ nonce })}\n`, {
    flag: "wx",
  });
  fs.mkdirSync(path.join(proofDir, "state"));
  fs.mkdirSync(path.join(proofDir, "evidence"));
  let unit;
  let report;
  const cancelled = new AbortController();
  let outputBytes = 0;
  const output = [];
  try {
    // Refuse slow preparation before any scope is created; leave cleanup its full allowance.
    assert.ok(performance.now() - begin < 2000, "Browser owner preparation exceeded 2s");
    const code = await runManagedCommand({
      bin: process.execPath,
      args: [
        "--max-old-space-size=512",
        script,
        mode === "browser" ? "__browser_worker" : "__sandbox_worker",
        ...values,
        nonce,
      ],
      cwd: source,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=512" },
      memoryLimitBytes: LIMIT,
      onMemoryScope: (value) => {
        unit = value;
      },
      // 20s worker + 5s admission + up to 7s inner join + 20.05s scope cleanup
      // + 3s readback + <2s preparation leaves margin within the unchanged 60s wall.
      timeoutMs: WORKER_TIMEOUT_MS,
      timeoutKillGraceMs: 1000,
      abortKillGraceMs: 1000,
      signalKillGraceMs: 1000,
      cleanupDrainTimeoutMs: 2000,
      requireProcessTreeExit: true,
      signal: cancelled.signal,
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        const collect = (chunk) => {
          outputBytes += chunk.length;
          if (outputBytes > 1024 ** 2) {
            cancelled.abort(new Error("Browser qualifier output exceeded 1MiB"));
            return;
          }
          output.push(chunk);
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
      },
    });
    assert.equal(code, 0, "Managed browser worker failed");
    report = JSON.parse(fs.readFileSync(path.join(proofDir, "unqualified-browser.json"), "utf8"));
    assert.equal(report.passed, true);
    assert.equal(report.workerContainment.nonce, nonce);
    const { before, after } = report.workerContainment;
    verifyKernelReceipts(before, after, unit);
    const joined = emptyScope(unit, before);
    const elapsedMs = Math.round(performance.now() - begin);
    assert.ok(elapsedMs < 60000, "Full browser execution/cleanup exceeded 60s");
    report.containment = {
      verified: true,
      unit,
      memoryLimitBytes: LIMIT,
      memorySwapMax: 0,
      maxLimitEvents: 0,
      oomEvents: 0,
      oomKillEvents: 0,
      oomGroupKillEvents: after.events.oom_group_kill ?? null,
      peakBytes: after.peak,
      nodeV8MiB: 512,
      elapsedMs,
      outerWallLimitMs: 60000,
      workerTimeoutMs: WORKER_TIMEOUT_MS,
      ...joined,
      managedOwner: fileHash(ownerPath),
    };
    report.cleanup.processTreeVerifiedEmpty = true;
    report.cleanup.requiresOuterProcessTreeVerification = false;
    report.assertions.push("owned-cgroup-limit-and-extinction-verified");
  } catch (error) {
    report = {
      schemaVersion: 1,
      phase: "browser",
      passed: false,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      error: String(error.message).slice(0, 2000),
      managedOwnerUnjoinedWork: hasUnjoinedWork(error),
      unit,
    };
  }
  fs.writeFileSync(path.join(proofDir, "managed-output.log"), Buffer.concat(output), {
    flag: "wx",
  });
  fs.writeFileSync(path.join(proofDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  return report;
}
