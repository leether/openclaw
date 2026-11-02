// Opt-in metadata only. These observations never admit artifacts or change cleanup.
import { writeSync } from "node:fs";
import os from "node:os";
import { readProcessMemoryCapacity } from "./process-memory.mts";

export const BOUNDARY_DIAGNOSTIC_PREFIX = "[boundary-phase-v1] ";
export const BOUNDARY_DIAGNOSTIC_MAX_RECORDS = 128;
export const BOUNDARY_DIAGNOSTIC_MAX_BYTES = 64 * 1024;
// Eight units (SDK + seven producers) emit at most 32 records each in a cold
// preparation. The checker also runs other steps: share this one larger budget
// across their streams instead of resetting it for each command.
export const BOUNDARY_DIAGNOSTIC_RELAY_MAX_RECORDS = 512;
export const BOUNDARY_DIAGNOSTIC_RELAY_MAX_BYTES = 256 * 1024;
const phases = [
  "resources",
  "policy",
  "discovery",
  "kysely",
  "input-snapshot",
  "freshness",
  "compile",
  "receipt-validation",
  "publication",
  "native-config",
  "native-snapshot",
  "native-diagnostics",
  "native-emit",
  "native-inputs",
  "native-close",
  "native-seal",
  "worker-publication",
  "preparation-callback",
  "entry-ownership",
  "child-ready",
  "child-exit",
  "child-close",
  "stdout-close",
  "stderr-close",
  "managed-settlement",
  "diagnostics",
] as const;
type Phase = (typeof phases)[number];
const roles = ["preparation", "worker", "native", "checker"] as const;
type Role = (typeof roles)[number];
const units = new Set([
  "preparation",
  "plugin-sdk",
  "qa-channel",
  "memory-core",
  "matrix",
  "discord",
  "slack",
  "telegram",
  "whatsapp",
  "other",
]);
const countKeys = new Set([
  "inputs",
  "outputs",
  "roots",
  "plugins",
  "childPid",
  "exitCode",
  "fresh",
  "emitted",
  "signaled",
]);
type Counts = Partial<
  Record<
    | "inputs"
    | "outputs"
    | "roots"
    | "plugins"
    | "childPid"
    | "exitCode"
    | "fresh"
    | "emitted"
    | "signaled",
    number
  >
>;
const numericKeys = [
  "pid",
  "monotonicMs",
  "elapsedMs",
  "nodeRssBytes",
  "nodeCpuUserUs",
  "nodeCpuSystemUs",
  "logicalCpuCount",
  "hostTotalBytes",
  "memoryCapacityBytes",
  "hostAvailableBytes",
  "goMaxProcs",
  "goGc",
] as const;
const recordKeys = new Set([
  "version",
  "role",
  "unit",
  "phase",
  "event",
  "counts",
  "goMemoryLimit",
  ...numericKeys,
]);
const numberOrNull = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const measured = (read: () => number | null) => {
  try {
    const value = read();
    return numberOrNull(value) ? value : null;
  } catch {
    return null;
  }
};
const goNumber = (value: string | undefined) =>
  value && /^\d{1,9}$/u.test(value) ? Number(value) : null;
const goMemory = (value: string | undefined) =>
  value && /^\d{1,9}(?:B|KiB|MiB|GiB)$/u.test(value) ? value : null;

export function boundaryDiagnosticUnit(value: string) {
  const match = value.replaceAll("\\", "/").match(/(?:^|\/)(?:extensions|packages)\/([^/]+)\//u);
  return match?.[1] && units.has(match[1]) ? match[1] : units.has(value) ? value : "other";
}

export function isBoundaryDiagnostic(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === recordKeys.size &&
    Object.keys(value).every((key) => recordKeys.has(key)) &&
    value.version === 1 &&
    roles.some((role) => role === value.role) &&
    typeof value.unit === "string" &&
    units.has(value.unit) &&
    phases.some((phase) => phase === value.phase) &&
    typeof value.event === "string" &&
    ["start", "end", "info", "failed", "truncated"].includes(value.event) &&
    numericKeys.every((key) => numberOrNull(value[key])) &&
    typeof value.pid === "number" &&
    value.pid > 0 &&
    (value.goMemoryLimit === null ||
      (typeof value.goMemoryLimit === "string" &&
        goMemory(value.goMemoryLimit) === value.goMemoryLimit)) &&
    record(value.counts) &&
    Object.entries(value.counts).every(
      ([key, count]) =>
        countKeys.has(key) &&
        typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= 0,
    )
  );
}

function boundedSink(
  write: (line: string) => void,
  maxRecords = BOUNDARY_DIAGNOSTIC_MAX_RECORDS,
  maxBytes = BOUNDARY_DIAGNOSTIC_MAX_BYTES,
) {
  let records = 0;
  let bytes = 0;
  let truncated = false;
  return (value: Record<string, unknown>) => {
    if (truncated || !isBoundaryDiagnostic(value)) {
      return;
    }
    let line = `${BOUNDARY_DIAGNOSTIC_PREFIX}${JSON.stringify(value)}\n`;
    if (records >= maxRecords - 1 || bytes + Buffer.byteLength(line) > maxBytes - 2048) {
      truncated = true;
      line = `${BOUNDARY_DIAGNOSTIC_PREFIX}${JSON.stringify({ ...value, phase: "diagnostics", event: "truncated", counts: { emitted: records } })}\n`;
    }
    records++;
    bytes += Buffer.byteLength(line);
    try {
      write(line);
    } catch {
      /* Diagnostics cannot replace the original result. */
    }
  };
}

// Synchronous writes are caught by the sink, including a closed stderr pipe;
// diagnostics must not introduce an asynchronous unhandled stream error.
const writeDiagnostic = (line: string) => {
  writeSync(2, line);
};
const defaultSink = boundedSink(writeDiagnostic);

export function createBoundaryDiagnostics(
  role: Role,
  unit: string,
  options: {
    env?: NodeJS.ProcessEnv;
    write?: (line: string) => void;
    now?: () => number;
    resources?: () => {
      logicalCpuCount: number | null;
      hostTotalBytes: number | null;
      memoryCapacityBytes: number | null;
      hostAvailableBytes: number | null;
    };
  } = {},
) {
  const env = options.env ?? process.env;
  const enabled = env.OPENCLAW_EXTENSION_BOUNDARY_DIAGNOSTICS === "1";
  const now = options.now ?? (() => Number(process.hrtime.bigint() / 1000000n));
  const emit = options.write ? boundedSink(options.write) : defaultSink;
  const mark = (
    phase: Phase,
    event: string,
    counts: Counts = {},
    elapsedMs: number | null = null,
    policy: NodeJS.ProcessEnv = env,
  ) => {
    if (!enabled) {
      return;
    }
    const cpu = (() => {
      try {
        return process.cpuUsage();
      } catch {
        return null;
      }
    })();
    let resources = {
      logicalCpuCount: null as number | null,
      hostTotalBytes: null as number | null,
      memoryCapacityBytes: null as number | null,
      hostAvailableBytes: null as number | null,
    };
    if (phase === "resources" || phase === "policy") {
      try {
        resources =
          options.resources?.() ??
          (() => {
            const memory = readProcessMemoryCapacity({});
            return {
              logicalCpuCount: os.availableParallelism(),
              hostTotalBytes: os.totalmem(),
              memoryCapacityBytes: memory.capacityBytes,
              hostAvailableBytes: memory.availableBytes,
            };
          })();
      } catch {
        /* Unavailable observations stay null, never zero. */
      }
    }
    emit({
      version: 1,
      role,
      unit: boundaryDiagnosticUnit(unit),
      phase,
      event,
      pid: process.pid,
      monotonicMs: measured(now),
      elapsedMs,
      counts,
      nodeRssBytes: measured(() => process.memoryUsage.rss()),
      nodeCpuUserUs: cpu?.user ?? null,
      nodeCpuSystemUs: cpu?.system ?? null,
      ...resources,
      goMaxProcs: goNumber(policy.GOMAXPROCS),
      goGc: goNumber(policy.GOGC),
      goMemoryLimit: goMemory(policy.GOMEMLIMIT),
    });
  };
  return {
    mark,
    policy: (policy: NodeJS.ProcessEnv) => mark("policy", "info", {}, null, policy),
    start(phase: Phase, counts: Counts = {}) {
      const started = enabled ? measured(now) : null;
      mark(phase, "start", counts);
      return (completed: Counts = {}) =>
        mark(
          phase,
          "end",
          completed,
          started === null ? null : measured(() => Math.max(0, now() - started)),
        );
    },
  };
}

/** Shared checker budget, independent parser state for each child's stream. */
export function createBoundaryDiagnosticRelayGroup(
  write: (line: string) => void = writeDiagnostic,
) {
  const emit = boundedSink(
    write,
    BOUNDARY_DIAGNOSTIC_RELAY_MAX_RECORDS,
    BOUNDARY_DIAGNOSTIC_RELAY_MAX_BYTES,
  );
  return (env = process.env) => createBoundaryDiagnosticRelay(env, emit);
}

/** Live relay accepts only bounded schema records; original capture remains untouched. */
function createBoundaryDiagnosticRelay(
  env: NodeJS.ProcessEnv,
  emit: (value: Record<string, unknown>) => void,
) {
  let partial = "";
  let discard = false;
  return (chunk: string) => {
    if (env.OPENCLAW_EXTENSION_BOUNDARY_DIAGNOSTICS !== "1") {
      return;
    }
    // Visit bounded segments; never retain an arbitrary compiler output chunk.
    for (let offset = 0; offset < chunk.length; offset += 2048) {
      const pieces = chunk.slice(offset, offset + 2048).split("\n");
      for (let index = 0; index < pieces.length; index++) {
        const piece = pieces[index] ?? "";
        if (!discard) {
          partial += piece;
          if (partial.length > 4096) {
            partial = "";
            discard = true;
          }
        }
        if (index === pieces.length - 1) {
          continue;
        }
        if (!discard) {
          const line = partial.startsWith(BOUNDARY_DIAGNOSTIC_PREFIX)
            ? partial
            : partial.replace(/^\[[a-z0-9 -]{1,64}\] /u, "");
          if (line.startsWith(BOUNDARY_DIAGNOSTIC_PREFIX)) {
            try {
              const value: unknown = JSON.parse(line.slice(BOUNDARY_DIAGNOSTIC_PREFIX.length));
              if (isBoundaryDiagnostic(value)) {
                emit(value);
              }
            } catch {
              /* Not a diagnostic. */
            }
          }
        }
        partial = "";
        discard = false;
      }
    }
  };
}
