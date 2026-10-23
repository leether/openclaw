import { EventEmitter } from "node:events";
import fs, { type FSWatcher } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertOomProof,
  observeCgroupOom,
  parseOomSnapshot,
} from "./managed-memory-oom-observer.js";

const binding = {
  unit: "openclaw-check-11111111-2222-4333-8444-555555555555.scope",
  nonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  cgroup: "/user.slice/openclaw-check-11111111-2222-4333-8444-555555555555.scope",
};
const ready = {
  ...binding,
  device: "1",
  inode: "2",
  eventsDevice: "1",
  eventsInode: "3",
  oom: 0,
  oomKill: 0,
};

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const realStat = fs.statSync(import.meta.filename, { bigint: true });
  const realFilesystem = fs.statfsSync(process.cwd());
  const directoryStat = { ...realStat, dev: 1n, ino: 2n };
  const eventsStat = { ...realStat, dev: 1n, ino: 3n };
  const closeWatcher = vi.fn();
  const watcher: FSWatcher = Object.assign(new EventEmitter(), {
    close: closeWatcher,
    ref() {
      return this;
    },
    unref() {
      return this;
    },
  });
  const input = { raw: "low 0\nmax 0\noom 0\noom_kill 0\n", inode: 3n };
  vi.spyOn(fs, "realpathSync").mockImplementation((target) => String(target));
  const filesystem = vi
    .spyOn(fs, "statfsSync")
    .mockReturnValue(Object.assign(realFilesystem, { type: 0x63677270 }));
  const open = vi.spyOn(fs, "openSync").mockReturnValueOnce(10).mockReturnValueOnce(11);
  const close = vi.spyOn(fs, "closeSync").mockImplementation(() => {});
  vi.spyOn(fs, "fstatSync").mockImplementation((fd) =>
    fd === 10 ? directoryStat : { ...eventsStat, ino: input.inode },
  );
  vi.spyOn(fs, "statSync").mockImplementation((target) =>
    String(target).endsWith("memory.events.local") ? eventsStat : directoryStat,
  );
  vi.spyOn(fs, "readSync").mockImplementation((_fd, buffer) => {
    if (!(buffer instanceof Buffer)) {
      throw new Error("Expected the bounded observer buffer");
    }
    return buffer.write(input.raw);
  });
  vi.spyOn(fs, "watch").mockImplementation((_target, optionsOrListener) => {
    if (typeof optionsOrListener !== "function") {
      throw new Error("Expected the file-modified listener");
    }
    watcher.on("change", optionsOrListener);
    return watcher;
  });
  const abort = new AbortController();
  const onReady = vi.fn();
  return {
    input,
    watcher,
    closeWatcher,
    filesystem,
    open,
    close,
    abort,
    onReady,
    observe: () => observeCgroupOom(binding, abort.signal, onReady),
    changed: () => watcher.emit("change", "change", "memory.events.local"),
  };
}

it("arms the exact cgroup files before readiness and closes them after a observed local counter delta", async () => {
  const io = fixture();
  const result = io.observe();
  expect(io.onReady).toHaveBeenCalledExactlyOnceWith(ready);
  io.input.raw = "oom 1\noom_kill 2\n";
  io.changed();
  const observed = await result;
  assertOomProof({ binding, ready, observed, scopeRemoved: true });
  expect(io.closeWatcher).toHaveBeenCalledOnce();
  expect(io.close.mock.calls).toEqual([[11], [10]]);
});

it.for(["cancel", "timeout"])(
  "closes all observation handles on %s without an OOM receipt",
  async (kind) => {
    const io = fixture();
    const result = io.observe();
    const failure = new DOMException(kind, kind === "cancel" ? "AbortError" : "TimeoutError");
    io.abort.abort(failure);
    await expect(result).rejects.toBe(failure);
    expect(io.closeWatcher).toHaveBeenCalledOnce();
    expect(io.close.mock.calls).toEqual([[11], [10]]);
  },
);

it("does not open observation files for a pre-cancelled invocation", async () => {
  const io = fixture();
  io.abort.abort();
  await expect(io.observe()).rejects.toMatchObject({ name: "AbortError" });
  expect(io.open).not.toHaveBeenCalled();
  expect(io.onReady).not.toHaveBeenCalled();
});

it("rejects forged counters on an ordinary filesystem before readiness", async () => {
  const io = fixture();
  const otherFilesystem = Object.assign(fs.statfsSync(process.cwd()), { type: 0x1234 });
  io.filesystem.mockReturnValue(otherFilesystem);
  await expect(io.observe()).rejects.toThrow("exact cgroup-v2");
  expect(io.open).not.toHaveBeenCalled();
  expect(io.onReady).not.toHaveBeenCalled();
});

it.for([
  { ...binding, cgroup: "/user.slice/another.scope" },
  { ...binding, cgroup: "/user.slice/../" + binding.unit },
  { ...binding, nonce: "another-invocation" },
])("rejects an invalid allocation-barrier binding: %j", async (other) => {
  const io = fixture();
  await expect(observeCgroupOom(other, io.abort.signal, io.onReady)).rejects.toThrow("identity");
  expect(io.open).not.toHaveBeenCalled();
  expect(io.onReady).not.toHaveBeenCalled();
});

it.for(["oom 1\n", "oom 1\noom_kill 1\noom_kill 2\n", "oom 1\noom_kill 9007199254740992\n"])(
  "rejects missing, duplicate or inexact initial counters: %s",
  async (raw) => {
    const io = fixture();
    io.input.raw = raw;
    await expect(io.observe()).rejects.toThrow("OOM counter");
    expect(io.onReady).not.toHaveBeenCalled();
    expect(io.closeWatcher).toHaveBeenCalledOnce();
    expect(io.close.mock.calls).toEqual([[11], [10]]);
  },
);

it("rejects an earlier OOM instead of borrowing the scope's cumulative history", async () => {
  const io = fixture();
  io.input.raw = "oom 1\noom_kill 1\n";
  await expect(io.observe()).rejects.toThrow("already has a kill counter");
  expect(io.onReady).not.toHaveBeenCalled();
});

it("rejects a replaced events inode even when its counter increased", async () => {
  const io = fixture();
  const result = io.observe();
  io.input.inode = 4n;
  io.input.raw = "oom 1\noom_kill 1\n";
  io.changed();
  await expect(result).rejects.toThrow("identity changed");
  expect(io.closeWatcher).toHaveBeenCalledOnce();
  expect(io.close.mock.calls).toEqual([[11], [10]]);
});

it("rejects a missing counter after readiness instead of inventing a kill event", async () => {
  const io = fixture();
  const result = io.observe();
  io.input.raw = "oom 1\n";
  io.changed();
  await expect(result).rejects.toThrow("OOM counter");
  expect(io.closeWatcher).toHaveBeenCalledOnce();
  expect(io.close.mock.calls).toEqual([[11], [10]]);
});

it("fails closed when the kernel subscription disappears", async () => {
  const io = fixture();
  const result = io.observe();
  const failure = Object.assign(new Error("scope removed"), { code: "ENOENT" });
  io.watcher.emit("error", failure);
  await expect(result).rejects.toBe(failure);
  expect(io.closeWatcher).toHaveBeenCalledOnce();
  expect(io.close.mock.calls).toEqual([[11], [10]]);
});

it("does not turn an ordinary 143 cancellation into an OOM proof", () => {
  expect(() => assertOomProof({ binding, ready, observed: ready, scopeRemoved: true })).toThrow(
    "No new kernel OOM",
  );
});

it("rejects a host or ancestor OOM victim without a local limit OOM event", () => {
  expect(() =>
    assertOomProof({
      binding,
      ready,
      observed: { ...ready, oomKill: 1 },
      scopeRemoved: true,
    }),
  ).toThrow("No new kernel OOM");
});

it.for(["unit", "nonce", "cgroup", "device", "inode", "eventsDevice", "eventsInode"] as const)(
  "rejects a receipt with another %s",
  (field) => {
    expect(() =>
      assertOomProof({
        binding,
        ready,
        observed: { ...ready, [field]: "other", oom: 1, oomKill: 1 },
        scopeRemoved: true,
      }),
    ).toThrow();
  },
);

it("requires verified whole-scope cleanup even with a valid OOM kill", () => {
  expect(() =>
    assertOomProof({
      binding,
      ready,
      observed: { ...ready, oom: 1, oomKill: 1 },
      scopeRemoved: false,
    }),
  ).toThrow("cleanup is not verified");
});

it.for([
  "{}",
  "null",
  JSON.stringify({ ...ready, phase: "observed", oomKill: "1" }),
  JSON.stringify({ ...ready, phase: "ready" }),
])("rejects malformed or wrongly phased observer output: %s", (line) => {
  expect(() => parseOomSnapshot(line, "observed")).toThrow();
});
