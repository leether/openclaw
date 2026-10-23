import { spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  hasUnjoinedWork,
  runManagedCommand,
  signalExitCode,
} from "../../scripts/lib/managed-child-process.mts";
import { awaitGateBeforeSettlement, createDeferred } from "../helpers/promise.js";
import { assertOomProof, parseOomSnapshot } from "./managed-memory-oom-observer.js";
import { hasSemanticTestBackend } from "./native-boundary-fixture.js";

const available = process.platform === "linux" && hasSemanticTestBackend();

it.runIf(available)(
  "contains aggregate native allocations and joins the whole cgroup after OOM",
  async ({ signal }) => {
    let memoryScope = "";
    const nonce = randomUUID();
    const cancelled = new AbortController();
    const ownedSignal = AbortSignal.any([signal, cancelled.signal]);
    const workloadReady = createDeferred<string>();
    const observerReady = createDeferred<string>();
    let workload: ChildProcess | undefined;
    let observer: ChildProcess | undefined;
    let observerResult: Promise<number> | undefined;
    const capture = (child: ChildProcess, ready: (line: string) => void) => {
      let stdout = "";
      let stderrBytes = 0;
      child.stdout?.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stdout) + chunk.length > 8_192) {
          cancelled.abort(new Error("OOM fixture output exceeded its bound"));
          return;
        }
        stdout += chunk.toString("utf8");
        const newline = stdout.indexOf("\n");
        if (newline >= 0) {
          ready(stdout.slice(0, newline));
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 8_192) {
          cancelled.abort(new Error("OOM fixture stderr exceeded its bound"));
        }
      });
      child.stdin?.on("error", (error) => cancelled.abort(error));
      return () => stdout;
    };
    let observerOutput = () => "";
    // Keep a clearly over-limit workload reachable until the kernel ends it.
    // Two exact 128 MiB allocations can leave the OOM victim signal runtime-dependent.
    const allocate =
      "const a=globalThis.allocations=[];for(let i=0;i<20;i++)a.push(Buffer.alloc(8*1024**2,1));setInterval(()=>{},1000)";
    const result = runManagedCommand({
      bin: process.execPath,
      args: [
        "-e",
        [
          "const {spawn}=require('node:child_process');",
          "const nonce=" + JSON.stringify(nonce) + ";",
          "const group=require('node:fs').readFileSync('/proc/self/cgroup','utf8').trim().split('\\n').find(s=>s.startsWith('0::'));",
          "console.log(nonce+' '+group?.slice(3));",
          "let input='';process.stdin.on('data',chunk=>{input+=chunk;if(input.length>128)process.exit(76)});",
          "process.stdin.once('end',()=>{if(input!==nonce+'\\n')process.exit(76);",
          "for(let i=0;i<2;i++)spawn(process.execPath,['-e'," +
            JSON.stringify(allocate) +
            "],{stdio:'inherit'});",
          "setInterval(()=>{},1000);});",
        ].join("\n"),
      ],
      memoryLimitBytes: 256 * 1024 ** 2,
      onMemoryScope(unit) {
        memoryScope = unit;
      },
      timeoutMs: 15_000,
      requireProcessTreeExit: true,
      signal: ownedSignal,
      stdio: "pipe",
      onReady(child) {
        workload = child;
        capture(child, workloadReady.resolve);
      },
    });
    // Observe early failures while setup waits for the workload's own cgroup path.
    void result.catch(() => {});
    try {
      const hello = await awaitGateBeforeSettlement(
        workloadReady.promise,
        result,
        "OOM workload exited before its allocation barrier",
      );
      expect(hello.startsWith(nonce + " /")).toBe(true);
      const cgroup = hello.slice(nonce.length + 1);
      const binding = { unit: memoryScope, nonce, cgroup };
      observerResult = runManagedCommand({
        bin: process.execPath,
        args: [
          "--max-old-space-size=32",
          fileURLToPath(new URL("./managed-memory-oom-observer.ts", import.meta.url)),
          memoryScope,
          nonce,
          cgroup,
        ],
        env: { ...process.env, NODE_OPTIONS: "" },
        timeoutMs: 15_000,
        abortKillGraceMs: 1_000,
        requireProcessTreeExit: true,
        signal: ownedSignal,
        stdio: "pipe",
        onReady(child) {
          observer = child;
          observerOutput = capture(child, observerReady.resolve);
        },
      });
      void observerResult.catch(() => {});
      const ready = parseOomSnapshot(
        await awaitGateBeforeSettlement(
          observerReady.promise,
          observerResult,
          "OOM observer exited before becoming ready",
        ),
        "ready",
      );
      expect(ready).toMatchObject({ ...binding, oom: 0, oomKill: 0 });
      const current = fs.statSync("/sys/fs/cgroup" + cgroup, { bigint: true });
      expect([ready.device, ready.inode]).toEqual([String(current.dev), String(current.ino)]);
      workload?.stdin?.end(nonce + "\n");
      const [code, observerCode] = await Promise.all([result, observerResult]);
      expect(observerCode).toBe(0);
      const lines = observerOutput().trim().split("\n");
      expect(lines).toHaveLength(2);
      const observedLine = lines[1];
      if (!observedLine) {
        throw new Error("OOM observer did not publish its final event");
      }
      const observed = parseOomSnapshot(observedLine, "observed");
      const state = spawnSync(
        "systemctl",
        ["--user", "show", "--property=LoadState", memoryScope],
        {
          encoding: "utf8",
          timeout: 5_000,
          killSignal: "SIGKILL",
        },
      );
      assertOomProof({
        binding,
        ready,
        observed,
        scopeRemoved:
          !state.error &&
          state.stdout.trim() === "LoadState=not-found" &&
          !fs.existsSync("/sys/fs/cgroup" + cgroup),
      });
      const observerPid = observer?.pid;
      if (!observerPid) {
        throw new Error("OOM observer has no process identity");
      }
      expect(() => process.kill(observerPid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
      // Wrapper cleanup can report SIGTERM after a descendant was OOM-killed.
      // Neither 137 nor 143 establishes OOM without the bound kernel delta above.
      console.info("Managed OOM receipt", {
        unit: memoryScope,
        wrapperExit: code,
        eventsFile: "memory.events.local",
        oomDelta: observed.oom - ready.oom,
        oomKillDelta: observed.oomKill - ready.oomKill,
      });
    } finally {
      cancelled.abort();
      const outcomes = await Promise.allSettled([
        result,
        ...(observerResult ? [observerResult] : []),
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          expect(hasUnjoinedWork(outcome.reason)).toBe(false);
        }
      }
    }
  },
  25_000,
);

it.runIf(available).for([false, true])(
  "returns the workload result through a verified bounded launcher (shell: %s)",
  { timeout: 20_000 },
  async (shell, { signal }) => {
    let output = "";
    const code = await runManagedCommand({
      bin: shell ? "printf 'bounded\\n'; exit 7" : process.execPath,
      args: shell ? [] : ["-e", "process.stdin.pipe(process.stdout);process.exitCode=7;"],
      shell,
      memoryLimitBytes: 256 * 1024 ** 2,
      timeoutMs: 10_000,
      requireProcessTreeExit: true,
      signal,
      stdio: shell ? ["ignore", "pipe", "pipe"] : "pipe",
      onReady(child) {
        child.stdout!.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stdin?.end("bounded\n");
      },
    });
    expect(code).toBe(7);
    expect(output).toBe("bounded\n");
  },
);

it.runIf(available).for(["SIGPIPE", "SIGUSR1"] as const)(
  "preserves native %s exit status through Node's special signal disposition",
  { timeout: 15_000 },
  async (signal, { signal: abortSignal }) => {
    let exitSignal: NodeJS.Signals | null | undefined;
    const code = await runManagedCommand({
      bin: "/bin/sh",
      args: ["-c", `kill -${signal.slice(3)} $$`],
      memoryLimitBytes: 256 * 1024 ** 2,
      timeoutMs: 10_000,
      signal: abortSignal,
      stdio: "ignore",
      onReady(child) {
        child.once("exit", (_code, received) => {
          exitSignal = received;
        });
      },
    });
    expect(code).toBe(signalExitCode(signal));
    expect(exitSignal).toBe(signal);
  },
);

it.runIf(available)(
  "keeps one cancellation signal and the caller's longer cleanup grace",
  async ({ signal }) => {
    const abort = new AbortController();
    let output = "";
    const result = runManagedCommand({
      bin: process.execPath,
      args: [
        "-e",
        [
          "let signals=0;process.on('SIGTERM',()=>{",
          "if(++signals>1)process.exit(9);process.stdout.write('term\\n');",
          // This must exceed the removed launcher's independent five-second timer.
          "setTimeout(()=>process.stdout.write('drained\\n',()=>process.exit(0)),5500)});",
          "setInterval(()=>{},1000);console.log('ready');",
        ].join("\n"),
      ],
      memoryLimitBytes: 256 * 1024 ** 2,
      timeoutMs: 15_000,
      abortKillGraceMs: 7_000,
      signal: AbortSignal.any([signal, abort.signal]),
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        child.stdout!.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("ready\n")) {
            abort.abort();
          }
        });
      },
    });
    await expect(result).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(output).toBe("ready\nterm\ndrained\n");
  },
  20_000,
);

it.runIf(available)(
  "joins a detached pipe holder with default cleanup options and no deadline",
  async ({ signal }) => {
    let memoryScope = "";
    let failure: unknown;
    let status: number | undefined;
    try {
      status = await runManagedCommand({
        bin: process.execPath,
        args: [
          "-e",
          [
            "const leaf=\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready');process.disconnect()\";",
            "const child=require('node:child_process').spawn(process.execPath,['-e',leaf],{detached:true,stdio:['ignore','inherit','inherit','ipc']});",
            "child.once('message',()=>process.exit(0));",
          ].join("\n"),
        ],
        memoryLimitBytes: 256 * 1024 ** 2,
        onMemoryScope(unit) {
          memoryScope = unit;
        },
        signal,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure !== undefined || (status !== undefined && status !== 0)).toBe(true);
    expect(hasUnjoinedWork(failure)).toBe(false);
    const state = spawnSync("systemctl", ["--user", "show", "--property=LoadState", memoryScope], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(state.stdout).toContain("LoadState=not-found");
  },
  30_000,
);

it.runIf(available)(
  "preserves a workload signal exit so surviving descendants drain gracefully",
  async ({ signal }) => {
    let output = "";
    let exitSignal: NodeJS.Signals | null | undefined;
    const leaf =
      "process.on('SIGTERM',()=>process.stdout.write('drained\\n',()=>process.exit(0)));setInterval(()=>{},1000);process.send('ready');process.disconnect()";
    const code = await runManagedCommand({
      bin: process.execPath,
      args: [
        "-e",
        [
          "const child=require('node:child_process').spawn(process.execPath,['-e'," +
            JSON.stringify(leaf) +
            "],{stdio:['ignore','inherit','inherit','ipc']});",
          "child.once('message',()=>process.kill(process.pid,'SIGTERM'));",
        ].join("\n"),
      ],
      memoryLimitBytes: 256 * 1024 ** 2,
      timeoutMs: 10_000,
      requireProcessTreeExit: true,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        child.stdout!.on("data", (chunk) => {
          output += String(chunk);
        });
        child.once("exit", (_code, received) => {
          exitSignal = received;
        });
      },
    });
    expect(code).toBe(143);
    expect(exitSignal).toBe("SIGTERM");
    expect(output).toBe("drained\n");
  },
  20_000,
);
