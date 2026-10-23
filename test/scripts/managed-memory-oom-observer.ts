import fs, { type FSWatcher } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Binding = { unit: string; nonce: string; cgroup: string };
type Snapshot = Binding & {
  device: string;
  inode: string;
  eventsDevice: string;
  eventsInode: string;
  oom: number;
  oomKill: number;
};

export function parseOomSnapshot(line: string, phase: "ready" | "observed"): Snapshot {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid OOM observer receipt");
  }
  if (
    !("phase" in value) ||
    value.phase !== phase ||
    !("unit" in value) ||
    typeof value.unit !== "string" ||
    !("nonce" in value) ||
    typeof value.nonce !== "string" ||
    !("cgroup" in value) ||
    typeof value.cgroup !== "string" ||
    !("device" in value) ||
    typeof value.device !== "string" ||
    !("inode" in value) ||
    typeof value.inode !== "string" ||
    !("eventsDevice" in value) ||
    typeof value.eventsDevice !== "string" ||
    !("eventsInode" in value) ||
    typeof value.eventsInode !== "string" ||
    !("oom" in value) ||
    typeof value.oom !== "number" ||
    !("oomKill" in value) ||
    typeof value.oomKill !== "number"
  ) {
    throw new Error("Invalid OOM observer receipt");
  }
  return {
    unit: value.unit,
    nonce: value.nonce,
    cgroup: value.cgroup,
    device: value.device,
    inode: value.inode,
    eventsDevice: value.eventsDevice,
    eventsInode: value.eventsInode,
    oom: value.oom,
    oomKill: value.oomKill,
  };
}

export function assertOomProof(params: {
  binding: Binding;
  ready: Snapshot;
  observed: Snapshot;
  scopeRemoved: boolean;
}) {
  const { binding, ready, observed, scopeRemoved } = params;
  for (const field of ["unit", "nonce", "cgroup"] as const) {
    if (ready[field] !== binding[field] || observed[field] !== binding[field]) {
      throw new Error("OOM evidence belongs to another invocation");
    }
  }
  for (const field of ["device", "inode", "eventsDevice", "eventsInode"] as const) {
    if (!/^\d+$/u.test(ready[field]) || ready[field] !== observed[field]) {
      throw new Error("OOM evidence changed cgroup identity");
    }
  }
  if (
    ready.oom !== 0 ||
    ready.oomKill !== 0 ||
    !Number.isSafeInteger(observed.oom) ||
    observed.oom <= ready.oom ||
    !Number.isSafeInteger(observed.oomKill) ||
    observed.oomKill <= ready.oomKill
  ) {
    throw new Error("No new kernel OOM kill in the owned cgroup");
  }
  if (!scopeRemoved) {
    throw new Error("OOM scope cleanup is not verified");
  }
}

/** The observer runs outside the workload's cgroup so OOM cleanup cannot kill it. */
export async function observeCgroupOom(
  binding: Binding,
  signal: AbortSignal,
  onReady: (snapshot: Snapshot) => void,
): Promise<Snapshot> {
  signal.throwIfAborted();
  if (
    !/^openclaw-check-[a-f0-9-]{36}\.scope$/u.test(binding.unit) ||
    !/^[a-f0-9-]{36}$/u.test(binding.nonce) ||
    !binding.cgroup.startsWith("/") ||
    path.posix.normalize(binding.cgroup) !== binding.cgroup ||
    !binding.cgroup.endsWith("/" + binding.unit)
  ) {
    throw new Error("Invalid OOM observation identity");
  }
  const directory = "/sys/fs/cgroup" + binding.cgroup;
  if (fs.realpathSync(directory) !== directory || fs.statfsSync(directory).type !== 0x63677270) {
    throw new Error("OOM events must come from the exact cgroup-v2 directory");
  }
  const directoryFd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  let eventsFd: number | undefined;
  let watcher: FSWatcher | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const directoryStat = fs.fstatSync(directoryFd, { bigint: true });
    const eventsPath = path.join(directory, "memory.events.local");
    eventsFd = fs.openSync(eventsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const eventsStat = fs.fstatSync(eventsFd, { bigint: true });
    const buffer = Buffer.alloc(4_096);
    const sample = (): Snapshot => {
      if (eventsFd === undefined) {
        throw new Error("OOM observer is closed");
      }
      const currentDirectory = fs.fstatSync(directoryFd, { bigint: true });
      const currentEvents = fs.fstatSync(eventsFd, { bigint: true });
      if (
        directoryStat.dev !== currentDirectory.dev ||
        directoryStat.ino !== currentDirectory.ino ||
        eventsStat.dev !== currentEvents.dev ||
        eventsStat.ino !== currentEvents.ino
      ) {
        throw new Error("OOM observer identity changed");
      }
      const length = fs.readSync(eventsFd, buffer, 0, buffer.length, 0);
      const counters = [
        ...buffer
          .subarray(0, length)
          .toString("utf8")
          .matchAll(/^oom_kill (\d+)$/gmu),
      ];
      const oomCounters = [
        ...buffer
          .subarray(0, length)
          .toString("utf8")
          .matchAll(/^oom (\d+)$/gmu),
      ];
      const oomKill = Number(counters[0]?.[1]);
      const oom = Number(oomCounters[0]?.[1]);
      if (
        length === buffer.length ||
        counters.length !== 1 ||
        oomCounters.length !== 1 ||
        !Number.isSafeInteger(oomKill) ||
        !Number.isSafeInteger(oom)
      ) {
        throw new Error("Missing or malformed OOM counter");
      }
      return {
        ...binding,
        device: String(directoryStat.dev),
        inode: String(directoryStat.ino),
        eventsDevice: String(eventsStat.dev),
        eventsInode: String(eventsStat.ino),
        oom,
        oomKill,
      };
    };
    return await new Promise<Snapshot>((resolve, reject) => {
      // Arm the file-modified subscription before releasing the allocation barrier.
      // Holding both descriptors preserves identity if --collect unlinks the cgroup.
      watcher = fs.watch(eventsPath, () => {
        try {
          const snapshot = sample();
          if (snapshot.oomKill > 0) {
            resolve(snapshot);
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error("OOM observation read failed"));
        }
      });
      watcher.once("error", reject);
      onAbort = () =>
        reject(
          signal.reason instanceof Error ? signal.reason : new Error("OOM observation cancelled"),
        );
      signal.addEventListener("abort", onAbort, { once: true });
      signal.throwIfAborted();
      const namedDirectory = fs.statSync(directory, { bigint: true });
      const namedEvents = fs.statSync(eventsPath, { bigint: true });
      if (
        directoryStat.dev !== namedDirectory.dev ||
        directoryStat.ino !== namedDirectory.ino ||
        eventsStat.dev !== namedEvents.dev ||
        eventsStat.ino !== namedEvents.ino
      ) {
        throw new Error("OOM files changed while arming observation");
      }
      const initial = sample();
      if (initial.oom !== 0 || initial.oomKill !== 0) {
        throw new Error("Fresh OOM scope already has a kill counter");
      }
      onReady(initial);
    });
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    watcher?.close();
    if (eventsFd !== undefined) {
      fs.closeSync(eventsFd);
    }
    fs.closeSync(directoryFd);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [unit = "", nonce = "", cgroup = ""] = process.argv.slice(2);
  const cancelled = new AbortController();
  const abort = () => cancelled.abort(new Error("OOM observation cancelled"));
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  process.stdin.once("end", abort).resume();
  try {
    const observed = await observeCgroupOom(
      { unit, nonce, cgroup },
      AbortSignal.any([cancelled.signal, AbortSignal.timeout(15_000)]),
      (ready) => process.stdout.write(JSON.stringify({ phase: "ready", ...ready }) + "\n"),
    );
    process.stdout.write(JSON.stringify({ phase: "observed", ...observed }) + "\n");
  } catch {
    // No host paths or unrelated process data; the caller retains the exact binding.
    process.stderr.write("Owned cgroup OOM observation failed\n");
    process.exitCode = 75;
  } finally {
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
    process.stdin.off("end", abort).destroy();
  }
}
