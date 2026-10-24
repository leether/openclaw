import { describe, expect, it, vi } from "vitest";
import {
  BOUNDARY_DIAGNOSTIC_MAX_BYTES,
  BOUNDARY_DIAGNOSTIC_MAX_RECORDS,
  BOUNDARY_DIAGNOSTIC_PREFIX,
  BOUNDARY_DIAGNOSTIC_RELAY_MAX_BYTES,
  BOUNDARY_DIAGNOSTIC_RELAY_MAX_RECORDS,
  boundaryDiagnosticUnit,
  createBoundaryDiagnosticRelayGroup,
  createBoundaryDiagnostics,
  isBoundaryDiagnostic,
} from "../../scripts/lib/boundary-phase-diagnostics.mts";

const enabled = { OPENCLAW_EXTENSION_BOUNDARY_DIAGNOSTICS: "1" };
const resources = () => ({
  logicalCpuCount: 2,
  hostTotalBytes: 8 * 1024 ** 3,
  memoryCapacityBytes: 3 * 1024 ** 3,
  hostAvailableBytes: 1024 ** 3,
});
function parsed(line: string) {
  const value: unknown = JSON.parse(line.slice(BOUNDARY_DIAGNOSTIC_PREFIX.length));
  if (!isBoundaryDiagnostic(value)) {
    throw new Error("Invalid diagnostic fixture");
  }
  return value;
}
function fixture(unit = "plugin-sdk") {
  const lines: string[] = [];
  const diagnostic = createBoundaryDiagnostics("native", unit, {
    env: enabled,
    write: (line) => lines.push(line),
    now: () => 1234,
    resources,
  });
  diagnostic.mark("resources", "info");
  const line = lines[0]!;
  return { line, value: parsed(line) };
}

describe("bounded boundary diagnostics", () => {
  it.each([undefined, "", "0", "true"])("is silent when opt-in is %s", (setting) => {
    const write = vi.fn();
    const observe = vi.fn(() => {
      throw new Error("must not observe");
    });
    const diagnostic = createBoundaryDiagnostics("worker", "plugin-sdk", {
      env: { OPENCLAW_EXTENSION_BOUNDARY_DIAGNOSTICS: setting },
      write,
      now: observe,
      resources: observe,
    });
    diagnostic.start("compile")({ outputs: 1 });
    diagnostic.mark("resources", "info");
    const relay = createBoundaryDiagnosticRelayGroup(write)({});
    relay(fixture().line);
    expect(write).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("records monotonic duration, self Node resources, and the effective Go policy", () => {
    let now = 10;
    const lines: string[] = [];
    const diagnostic = createBoundaryDiagnostics("preparation", "plugin-sdk", {
      env: enabled,
      write: (line) => lines.push(line),
      now: () => now,
      resources,
    });
    const done = diagnostic.start("compile");
    now = 37;
    done({ exitCode: 0 });
    diagnostic.policy({ GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" });
    expect(parsed(lines[1]!)).toMatchObject({ monotonicMs: 37, elapsedMs: 27, event: "end" });
    expect(parsed(lines[2]!)).toMatchObject({
      ...resources(),
      goMaxProcs: 2,
      goGc: 30,
      goMemoryLimit: "3GiB",
    });
    expect(parsed(lines[2]!).nodeRssBytes).toBeGreaterThan(0);
    expect(parsed(lines[2]!).pid).toBe(process.pid);
    expect(parsed(lines[2]!)).not.toHaveProperty("compilerRssBytes");
  });

  it("keeps failed observations unknown and never echoes arbitrary environment values", () => {
    const lines: string[] = [];
    const diagnostic = createBoundaryDiagnostics("native", "/private/secret/project/config.json", {
      env: enabled,
      write: (line) => lines.push(line),
      now: () => {
        throw new Error("unavailable");
      },
      resources: () => {
        throw new Error("unavailable");
      },
    });
    diagnostic.policy({ GOMAXPROCS: "secret", GOGC: "-1", GOMEMLIMIT: "secret-value" });
    expect(parsed(lines[0]!)).toMatchObject({
      unit: "other",
      monotonicMs: null,
      elapsedMs: null,
      logicalCpuCount: null,
      hostTotalBytes: null,
      memoryCapacityBytes: null,
      hostAvailableBytes: null,
      goMaxProcs: null,
      goGc: null,
      goMemoryLimit: null,
    });
    expect(lines.join("")).not.toContain("secret");
  });

  it.each([
    ["extensions/whatsapp/tsconfig.json", "whatsapp"],
    ["/private/x/packages/plugin-sdk/tsconfig.json", "plugin-sdk"],
    ["C:\\repo\\extensions\\matrix\\tsconfig.json", "matrix"],
    ["extensions/private-plugin/tsconfig.json", "other"],
    ["plugin-sdk", "plugin-sdk"],
  ])("restricts unit %s to %s", (input, expected) => {
    expect(boundaryDiagnosticUnit(input)).toBe(expected);
  });

  it("emits one truncation marker within the worker byte and record budgets", () => {
    const lines: string[] = [];
    const diagnostic = createBoundaryDiagnostics("native", "plugin-sdk", {
      env: enabled,
      write: (line) => lines.push(line),
      resources,
    });
    for (let index = 0; index < 1000; index++) {
      diagnostic.mark("native-emit", "info");
    }
    expect(lines.length).toBeLessThanOrEqual(BOUNDARY_DIAGNOSTIC_MAX_RECORDS);
    expect(Buffer.byteLength(lines.join(""))).toBeLessThanOrEqual(BOUNDARY_DIAGNOSTIC_MAX_BYTES);
    expect(lines.map(parsed).filter((value) => value.event === "truncated")).toHaveLength(1);
    expect(parsed(lines.at(-1)!)).toMatchObject({
      phase: "diagnostics",
      event: "truncated",
      counts: { emitted: lines.length - 1 },
    });
  });

  it("does not turn failed diagnostic writes into success or replace the original error", () => {
    const diagnostic = createBoundaryDiagnostics("worker", "plugin-sdk", {
      env: enabled,
      write: () => {
        throw new Error("sink closed");
      },
    });
    const original = new Error("original compilation failed");
    expect(() => {
      diagnostic.mark("compile", "failed");
      throw original;
    }).toThrow(original);
  });
});

describe("shared live relay", () => {
  it("accepts split raw and prefixed records without emitting TSFILE or ordinary errors", () => {
    const lines: string[] = [];
    const createStream = createBoundaryDiagnosticRelayGroup((line) => lines.push(line));
    const first = createStream(enabled);
    const second = createStream(enabled);
    const { line } = fixture();
    first(line.slice(0, 37));
    second(`[plugin-sdk boundary dts] ${line}`);
    first(line.slice(37));
    first("TSFILE: /private/source.d.ts\ncompiler original error\n");
    expect(lines).toEqual([line, line]);
  });

  it("retains all SDK plus seven producer tail events within the fixed checker budget", () => {
    const lines: string[] = [];
    const createStream = createBoundaryDiagnosticRelayGroup((line) => lines.push(line));
    for (const unit of [
      "plugin-sdk",
      "qa-channel",
      "memory-core",
      "matrix",
      "discord",
      "slack",
      "telegram",
      "whatsapp",
    ]) {
      const stream = createStream(enabled);
      const { value } = fixture(unit);
      // 32 exceeds the cold success path's 31 per-unit metadata events.
      for (let index = 0; index < 32; index++) {
        stream(
          `${BOUNDARY_DIAGNOSTIC_PREFIX}${JSON.stringify({ ...value, phase: "publication", event: "end", counts: { outputs: index } })}\n`,
        );
      }
    }
    expect(lines).toHaveLength(8 * 32);
    expect(lines.map(parsed).some((value) => value.event === "truncated")).toBe(false);
    expect(parsed(lines.at(-1)!)).toMatchObject({
      unit: "whatsapp",
      phase: "publication",
      event: "end",
      counts: { outputs: 31 },
    });
  });

  it("shares the cap across all streams and emits exactly one truncation marker", () => {
    const lines: string[] = [];
    const createStream = createBoundaryDiagnosticRelayGroup((line) => lines.push(line));
    for (let index = 0; index < 1000; index++) {
      createStream(enabled)(fixture().line);
    }
    expect(lines.length).toBeLessThanOrEqual(BOUNDARY_DIAGNOSTIC_RELAY_MAX_RECORDS);
    expect(Buffer.byteLength(lines.join(""))).toBeLessThanOrEqual(
      BOUNDARY_DIAGNOSTIC_RELAY_MAX_BYTES,
    );
    expect(lines.map(parsed).filter((value) => value.event === "truncated")).toHaveLength(1);
    expect(parsed(lines.at(-1)!)).toMatchObject({
      event: "truncated",
      counts: { emitted: lines.length - 1 },
    });
  });

  it.each([
    { phase: "private-source" },
    { unit: "private-target" },
    { role: "secret" },
    { goMemoryLimit: "3GiB PRIVATE" },
    { goMaxProcs: -1 },
    { counts: { raw: 1 } },
    { source: "secret" },
    { nodeRssBytes: -1 },
    { event: {} },
  ])("rejects records outside the public metadata schema: %j", (change) => {
    const lines: string[] = [];
    const stream = createBoundaryDiagnosticRelayGroup((line) => lines.push(line))(enabled);
    const value = { ...fixture().value, ...change };
    expect(isBoundaryDiagnostic(value)).toBe(false);
    stream(`${BOUNDARY_DIAGNOSTIC_PREFIX}${JSON.stringify(value)}\n`);
    expect(lines).toEqual([]);
  });

  it("bounds malformed partial lines and recovers only after their newline", () => {
    const lines: string[] = [];
    const stream = createBoundaryDiagnosticRelayGroup((line) => lines.push(line))(enabled);
    const { line } = fixture();
    stream(`${BOUNDARY_DIAGNOSTIC_PREFIX}${"x".repeat(100_000)}`);
    stream(line);
    expect(lines).toEqual([]);
    stream(line);
    expect(lines).toEqual([line]);
  });
});
