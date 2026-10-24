import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const TIMER_BUDGET_PROTOCOL = "timer-budget-v1";
export const TOOL_DRAIN_PROTOCOL = "tool-drain-v1";
export type TimerExecutionBudgetSpec = {
  version: typeof TIMER_BUDGET_PROTOCOL;
  remainingMs: number;
  answerReserveMs: 120000;
  maxSearchCalls: number;
  searchCallTimeoutMs: 45000;
  expectedOwnerEpoch?: string;
};

type TimerOwner = {
  spec: TimerExecutionBudgetSpec;
  deadlineAt: number;
  controller: AbortController;
  active: boolean;
  searchCalls: number;
};
const state = resolveGlobalSingleton(Symbol.for("openclaw.timerExecutionBudget"), () => ({
  context: new AsyncLocalStorage<TimerOwner>(),
  ownerEpoch: randomUUID(),
  actualToolExecutions: 0,
  timerRequests: 0,
}));

export function getTimerBudgetCapabilities() {
  return {
    protocol: TIMER_BUDGET_PROTOCOL,
    ownerEpoch: state.ownerEpoch,
    maxRemainingMs: 480000,
    answerReserveMs: 120000,
    maxSearchCalls: 4,
    searchCallTimeoutMs: 45000,
    scope: "in-process-openclaw" as const,
  };
}
export function getActualToolExecutionCount() {
  return state.actualToolExecutions;
}
export function getTimerRequestCount() {
  return state.timerRequests;
}

/** The authenticated HTTP owner accepts a bounded dialect, never loose prompt hints. */
export function parseTimerExecutionBudgetHeader(
  raw: string | string[] | undefined,
): TimerExecutionBudgetSpec | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || raw.length > 1024) {
    throw new Error("Invalid timer budget header");
  }
  const record: unknown = JSON.parse(raw);
  if (!isRecord(record)) {
    throw new Error("Invalid timer budget header");
  }
  const keys = new Set([
    "version",
    "remainingMs",
    "answerReserveMs",
    "maxSearchCalls",
    "searchCallTimeoutMs",
    "expectedOwnerEpoch",
  ]);
  if (
    Object.keys(record).some((key) => !keys.has(key)) ||
    record.version !== TIMER_BUDGET_PROTOCOL ||
    !Number.isInteger(record.remainingMs) ||
    typeof record.remainingMs !== "number" ||
    record.remainingMs < 1 ||
    record.remainingMs > 480000 ||
    record.answerReserveMs !== 120000 ||
    !Number.isInteger(record.maxSearchCalls) ||
    typeof record.maxSearchCalls !== "number" ||
    record.maxSearchCalls < 0 ||
    record.maxSearchCalls > 4 ||
    record.searchCallTimeoutMs !== 45000 ||
    (record.expectedOwnerEpoch !== undefined && record.expectedOwnerEpoch !== state.ownerEpoch)
  ) {
    throw new Error("Invalid timer budget or Gateway owner changed");
  }
  return {
    version: TIMER_BUDGET_PROTOCOL,
    remainingMs: record.remainingMs,
    answerReserveMs: record.answerReserveMs,
    maxSearchCalls: record.maxSearchCalls,
    searchCallTimeoutMs: record.searchCallTimeoutMs,
    ...(typeof record.expectedOwnerEpoch === "string"
      ? { expectedOwnerEpoch: record.expectedOwnerEpoch }
      : {}),
  };
}

export function createTimerExecutionBudget(
  spec: TimerExecutionBudgetSpec,
  controller: AbortController,
  onDeadline: () => void,
) {
  const owner: TimerOwner = {
    spec,
    deadlineAt: performance.now() + spec.remainingMs,
    controller,
    active: true,
    searchCalls: 0,
  };
  const timer = setTimeout(() => {
    controller.abort(new Error("Timer total execution budget exhausted"));
    onDeadline();
  }, spec.remainingMs);
  timer.unref?.();
  return {
    async run<T>(run: () => Promise<T>): Promise<T> {
      state.timerRequests += 1;
      try {
        return await state.context.run(owner, run);
      } finally {
        owner.active = false;
        clearTimeout(timer);
        controller.abort(new Error("Timer execution scope closed"));
        state.timerRequests -= 1;
      }
    },
  };
}

/** Remote and CLI/native harnesses do not inherit the process-local owner. */
export function assertTimerBudgetRuntimeSupported(runtime: string) {
  assertTimerOwnerRuntimeSupported(state.context.getStore(), runtime);
}

function assertTimerOwnerRuntimeSupported(owner: TimerOwner | undefined, runtime: string) {
  owner?.controller.signal.throwIfAborted();
  if (owner && (!owner.active || runtime !== "openclaw")) {
    throw new Error(
      `Timer budget does not support runtime ${runtime}; requires active in-process OpenClaw`,
    );
  }
}

function normalizeBaiduFreshness(toolName: string, params: unknown): unknown {
  if (!new Set(["baidu_search", "baidu_web_search"]).has(toolName) || !isRecord(params)) {
    return params;
  }
  const record = params;
  if (record.freshness === undefined) {
    return params;
  }
  if (typeof record.freshness !== "string") {
    throw new Error("Invalid Baidu freshness; use pd, pw, pm, py or YYYY-MM-DDtoYYYY-MM-DD");
  }
  const freshness = record.freshness.trim().toLowerCase();
  const aliases: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };
  const normalized = aliases[freshness] ?? freshness;
  const { freshness: _old, ...rest } = record;
  if (normalized === "recent") {
    return rest;
  }
  const range = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/.exec(normalized);
  const validRange =
    range &&
    range[1] !== undefined &&
    range[2] !== undefined &&
    range[1] <= range[2] &&
    range.slice(1).every((date) => {
      const parsed = Date.parse(date);
      return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
    });
  if (!["pd", "pw", "pm", "py"].includes(normalized) && !validRange) {
    throw new Error("Invalid Baidu freshness; use pd, pw, pm, py or YYYY-MM-DDtoYYYY-MM-DD");
  }
  return { ...rest, freshness: normalized };
}

/** Capture during construction; retained tools cannot borrow another request's budget. */
export function captureTimerToolExecution() {
  const owner = state.context.getStore();
  return {
    assertRuntimeSupported: (runtime: string) => assertTimerOwnerRuntimeSupported(owner, runtime),
    normalizeParams: (toolName: string, params: unknown) =>
      owner ? normalizeBaiduFreshness(toolName, params) : params,
    async execute<T>(
      toolName: string,
      signal: AbortSignal | undefined,
      invoke: (signal?: AbortSignal) => Promise<T>,
    ): Promise<T> {
      signal?.throwIfAborted();
      let toolTimer: ReturnType<typeof setTimeout> | undefined;
      let effectiveSignal = signal;
      if (owner) {
        owner.controller.signal.throwIfAborted();
        if (!owner.active) {
          throw new Error("Timer execution scope closed");
        }
        const researchMs = owner.deadlineAt - performance.now() - owner.spec.answerReserveMs;
        if (researchMs <= 0) {
          throw new Error(
            "Timer answer reserve reached; answer now using available evidence without more tools",
          );
        }
        const search = toolName !== "tool_search" && /(?:^|_)search(?:_|$)/.test(toolName);
        if (search && owner.searchCalls >= owner.spec.maxSearchCalls) {
          throw new Error("Timer search-call budget exhausted; answer using available evidence");
        }
        // This charge is synchronous at source entry, including each parallel invocation.
        if (search) {
          owner.searchCalls += 1;
        }
        const controller = new AbortController();
        effectiveSignal = AbortSignal.any([
          owner.controller.signal,
          controller.signal,
          ...(signal ? [signal] : []),
        ]);
        toolTimer = setTimeout(
          () =>
            controller.abort(
              new Error("Timer research tool budget exhausted; answer using available evidence"),
            ),
          Math.min(researchMs, search ? owner.spec.searchCallTimeoutMs : researchMs),
        );
        toolTimer.unref?.();
      }
      effectiveSignal?.throwIfAborted();
      state.actualToolExecutions += 1;
      // Count the actual source promise, not the abort race exposed to the model.
      const completeActualExecution = () => {
        state.actualToolExecutions -= 1;
        if (toolTimer) {
          clearTimeout(toolTimer);
        }
      };
      let source: Promise<T>;
      try {
        // Preserve the final source guard's synchronous admission boundary. A
        // microtask here would let a non-signal owner retire before source entry.
        source = Promise.resolve(invoke(effectiveSignal));
      } catch (error) {
        completeActualExecution();
        throw error;
      }
      const actual = source.finally(completeActualExecution);
      if (!owner || !effectiveSignal) {
        return await actual;
      }
      const observedSignal = effectiveSignal;
      let removeAbort = () => {};
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () =>
          reject(
            observedSignal.reason instanceof Error
              ? observedSignal.reason
              : new Error("Timer tool execution aborted", { cause: observedSignal.reason }),
          );
        removeAbort = () => observedSignal.removeEventListener("abort", onAbort);
        observedSignal.addEventListener("abort", onAbort, { once: true });
        if (observedSignal.aborted) {
          onAbort();
        }
      });
      try {
        return await Promise.race([actual, aborted]);
      } finally {
        removeAbort();
      }
    },
  };
}
