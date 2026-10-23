import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import { enqueueCommandInLane, resetAllLanes } from "../process/command-queue.js";
import { createDeferredCore } from "../shared/deferred.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { bindAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { runCliAgent } from "./cli-runner.js";
import { selectAgentHarness } from "./harness/selection.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "./runtime/internal-hooks.js";
import {
  assertTimerBudgetRuntimeSupported,
  captureTimerToolExecution,
  createTimerExecutionBudget,
  getActualToolExecutionCount,
  getTimerBudgetCapabilities,
  getTimerRequestCount,
  parseTimerExecutionBudgetHeader,
  type TimerExecutionBudgetSpec,
} from "./timer-execution-budget.js";
import {
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
} from "./tool-search.js";

const spec: TimerExecutionBudgetSpec = {
  version: "timer-budget-v1",
  remainingMs: 480000,
  answerReserveMs: 120000,
  maxSearchCalls: 4,
  searchCallTimeoutMs: 45000,
};
type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];
const result = { content: [{ type: "text" as const, text: "synthetic result" }], details: {} };
function tool(name = "baidu_search", execute: AnyAgentTool["execute"] = async () => result) {
  return wrapToolWithBeforeToolCallHook({
    name,
    label: name,
    description: name,
    parameters: Type.Object({ freshness: Type.Optional(Type.String()) }),
    execute,
  });
}
function budget(
  overrides: Partial<TimerExecutionBudgetSpec> = {},
  controller = new AbortController(),
  deadline = vi.fn(),
) {
  return createTimerExecutionBudget({ ...spec, ...overrides }, controller, deadline);
}
afterEach(() => {
  expect(getActualToolExecutionCount()).toBe(0);
  expect(getTimerRequestCount()).toBe(0);
  vi.useRealTimers();
  resetAllLanes();
});

describe("authenticated timer budget contract", () => {
  it.each([
    {},
    { remainingMs: 0 },
    { remainingMs: 480001 },
    { remainingMs: 1.5 },
    { maxSearchCalls: 5 },
    { answerReserveMs: 0 },
    { searchCallTimeoutMs: 45001 },
    { expectedOwnerEpoch: "old-owner" },
    { extra: true },
  ])("rejects invalid or stale contract %j", (override) => {
    const raw = Object.keys(override).length ? { ...spec, ...override } : {};
    expect(() => parseTimerExecutionBudgetHeader(JSON.stringify(raw))).toThrow();
  });
  it("accepts rollback 240 seconds and an exact owner, including answer-only remainder", () => {
    expect(parseTimerExecutionBudgetHeader(undefined)).toBeUndefined();
    for (const remainingMs of [480000, 240000, 119999]) {
      const candidate = {
        ...spec,
        remainingMs,
        expectedOwnerEpoch: getTimerBudgetCapabilities().ownerEpoch,
      };
      expect(parseTimerExecutionBudgetHeader(JSON.stringify(candidate))).toEqual(candidate);
    }
  });
  it("fails unsupported runtime before dispatch and leaves legacy requests alone", async () => {
    assertTimerBudgetRuntimeSupported("worker");
    await budget().run(async () => {
      assertTimerBudgetRuntimeSupported("openclaw");
      for (const runtime of ["worker", "cli", "codex"]) {
        expect(() => assertTimerBudgetRuntimeSupported(runtime)).toThrow("does not support");
      }
    });
  });
});

describe("real tool execution boundary", () => {
  it("counts the catalog dispatcher and target separately, retaining only the target after cancellation", async () => {
    const deferred = createDeferredCore<typeof result>();
    const started = createDeferredCore();
    const caller = new AbortController();
    const catalogRef = createToolSearchCatalogRef();
    let sourceCalls = 0;
    const pending = budget({}, caller).run(async () => {
      const controls = createToolSearchTools({ catalogRef });
      const source = tool("timer_fixture_tool", async () => {
        sourceCalls += 1;
        started.resolve();
        return await deferred.promise;
      });
      const compacted = applyToolSearchCatalog({ tools: [...controls, source], catalogRef });
      const control = toToolDefinitions(compacted.tools).find(
        (entry) => entry.name === "tool_call",
      );
      if (!control) {
        throw new Error("Expected the actual catalog dispatcher");
      }
      return await control.execute(
        "catalog-cancel",
        { id: source.name, args: {} },
        caller.signal,
        undefined,
        extensionContext,
      );
    });
    const settled = Promise.allSettled([pending]);
    try {
      await started.promise;
      expect(sourceCalls).toBe(1);
      expect(getActualToolExecutionCount()).toBe(2);
      caller.abort(new Error("synthetic caller cancellation"));
      await settled;
      // The owner's abort race can settle before the dispatcher's own finally.
      await expect.poll(getActualToolExecutionCount).toBe(1);
      expect(getTimerRequestCount()).toBe(0);
      deferred.resolve(result);
      await expect.poll(getActualToolExecutionCount).toBe(0);
      expect(sourceCalls).toBe(1);
    } finally {
      deferred.resolve(result);
      caller.abort();
      await settled;
      await expect.poll(getActualToolExecutionCount).toBe(0);
      clearToolSearchCatalog({ catalogRef });
    }
  });
  it("rejects the real CLI entry before lifecycle, credentials or backend preparation", async () => {
    await budget().run(async () => {
      expect(() => runCliAgent({} as Parameters<typeof runCliAgent>[0])).toThrow(
        "does not support runtime cli",
      );
    });
  });
  it.each([false, true])(
    "preserves synchronous source admission (budgeted=%s)",
    async (budgeted) => {
      let active = true;
      const started = vi.fn();
      const raw: AnyAgentTool = {
        name: "read",
        label: "read",
        description: "fixture",
        parameters: Type.Object({}),
        execute: async () => {
          started(active);
          return result;
        },
      };
      const guarded = bindAgentToolSourceExecutionGuard(raw, () => {
        if (!active) {
          throw new Error("source owner retired");
        }
        queueMicrotask(() => {
          active = false;
        });
      });
      const run = async () => {
        await wrapToolWithBeforeToolCallHook(guarded).execute("source-entry", {});
      };
      if (budgeted) {
        await budget().run(run);
      } else {
        await run();
      }
      expect(started).toHaveBeenCalledExactlyOnceWith(true);
      expect(active).toBe(false);
    },
  );
  it("fences a captured unwrapped preparer even when invoked outside its original scope", async () => {
    const prepare = vi.fn(async () => ({
      kind: "immediate" as const,
      outcome: { kind: "result" as const, result, isError: false },
      dispose: () => {},
    }));
    const raw: AnyAgentTool = {
      name: "custom",
      label: "custom",
      description: "fixture",
      parameters: Type.Object({}),
      execute: async () => result,
    };
    attachInternalToolExecutionPreparer(raw, prepare);
    let definition: ReturnType<typeof toToolDefinitions>[number];
    await budget().run(async () => {
      definition = toToolDefinitions([raw])[0]!;
      await expect(
        getInternalToolExecutionPreparer(definition)!({ toolCallId: "within", args: {} }),
      ).rejects.toThrow("unwrapped-tool-preparer");
    });
    await expect(
      getInternalToolExecutionPreparer(definition!)!({ toolCallId: "retained", args: {} }),
    ).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
  });
  it("allows automatic selection when the actual selected harness is OpenClaw", async () => {
    await budget().run(async () => {
      expect(selectAgentHarness({ provider: "synthetic-local-provider" }).id).toBe("openclaw");
    });
  });
  it("does not extend tool admission if the wall clock moves backwards", async () => {
    vi.useFakeTimers();
    await budget().run(async () => {
      const wrapped = tool("read");
      await vi.advanceTimersByTimeAsync(360000);
      vi.setSystemTime(new Date("2000-01-01T00:00:00Z"));
      await expect(wrapped.execute("wall-clock", {})).rejects.toThrow("answer reserve");
    });
  });

  it("charges four actual concurrent search calls and never invokes a fifth", async () => {
    const execute = vi.fn<AnyAgentTool["execute"]>(async () => result);
    await budget().run(async () => {
      const wrapped = toToolDefinitions([tool("baidu_search", execute)])[0]!;
      const outcomes = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          wrapped.execute(`parallel-${i}`, {}, undefined, undefined, extensionContext),
        ),
      );
      expect(execute).toHaveBeenCalledTimes(4);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(5);
      // Adapter translates the rejected source admission into an ordinary error result.
      expect(JSON.stringify(outcomes)).toContain("search-call budget exhausted");
    });
  });
  it.each([
    ["month", "pm"],
    ["week", "pw"],
    ["day", "pd"],
    ["year", "py"],
    ["pm", "pm"],
    ["2026-10-01to2026-10-20", "2026-10-01to2026-10-20"],
    ["recent", undefined],
  ])("normalizes Baidu freshness %s at source entry", async (freshness, expected) => {
    const execute = vi.fn<AnyAgentTool["execute"]>(async () => result);
    await budget().run(async () => {
      await tool("baidu_search", execute).execute("freshness", { freshness });
    });
    expect(execute.mock.calls[0]?.[1]).toEqual(expected ? { freshness: expected } : {});
  });
  it("rejects blank or unknown Baidu freshness before source execution", async () => {
    const execute = vi.fn<AnyAgentTool["execute"]>(async () => result);
    await budget().run(async () => {
      for (const freshness of ["", " ", "last-month", null, 7]) {
        await expect(
          tool("baidu_search", execute).execute("invalid", { freshness }),
        ).rejects.toThrow("Invalid Baidu freshness");
      }
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects impossible dates before execute and leaves Tavily freshness untouched", async () => {
    const execute = vi.fn<AnyAgentTool["execute"]>(async () => result);
    await budget().run(async () => {
      await expect(
        tool("baidu_search", execute).execute("bad", { freshness: "2026-02-30to2026-03-10" }),
      ).rejects.toThrow("Invalid Baidu");
      await tool("tavily_search", execute).execute("valid-tavily", { freshness: "recent" });
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual({ freshness: "recent" });
  });
  it("keeps legacy calls unchanged and tracks their actual settlement", async () => {
    const deferred = createDeferredCore<typeof result>();
    const started = createDeferredCore();
    const execute = vi.fn<AnyAgentTool["execute"]>(() => {
      started.resolve();
      return deferred.promise;
    });
    const pending = tool("baidu_search", execute).execute("legacy", { freshness: "month" });
    await started.promise;
    expect(execute).toHaveBeenCalledOnce();
    expect(getActualToolExecutionCount()).toBe(1);
    expect(execute.mock.calls[0]?.[1]).toEqual({ freshness: "month" });
    deferred.resolve(result);
    await pending;
  });
  it("reserves the final 120 seconds for answering without invoking more tools", async () => {
    vi.useFakeTimers();
    const execute = vi.fn<AnyAgentTool["execute"]>(async () => result);
    await budget().run(async () => {
      const wrapped = tool("read", execute);
      await vi.advanceTimersByTimeAsync(360000);
      await expect(wrapped.execute("reserve", {})).rejects.toThrow("answer reserve");
    });
    await budget({ remainingMs: 10000 }).run(async () => {
      await expect(tool("read", execute).execute("answer-only", {})).rejects.toThrow(
        "answer reserve",
      );
      // Model answering has no tool admission and remains allowed during the reserve.
      expect(getTimerRequestCount()).toBe(1);
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it("times out search at 45 seconds but keeps late actual execution blocking native drain", async () => {
    vi.useFakeTimers();
    const deferred = createDeferredCore<typeof result>();
    const execute = vi.fn<AnyAgentTool["execute"]>(() => deferred.promise);
    await budget().run(async () => {
      const pending = tool("tavily_search", execute).execute("late", {});
      const rejected = expect(pending).rejects.toThrow("research tool budget");
      await vi.advanceTimersByTimeAsync(45000);
      await rejected;
      expect(execute.mock.calls[0]?.[2]?.aborted).toBe(true);
      const drain = createGatewayActiveWorkSnapshot();
      expect(drain.idle).toBe(false);
      expect(drain.counts.actualToolExecutions).toBe(1);
      expect(drain.blockers).toContainEqual(
        expect.objectContaining({ kind: "tool-execution", count: 1 }),
      );
      deferred.resolve(result);
      await vi.advanceTimersByTimeAsync(0);
      expect(getActualToolExecutionCount()).toBe(0);
    });
  });
  it("rejects an already-cancelled caller before charging search or scheduling a tool timer", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    caller.abort(new Error("already cancelled"));
    const execute = vi.fn<AnyAgentTool["execute"]>(async () => result);
    await budget({ maxSearchCalls: 1 }).run(async () => {
      const wrapped = tool("baidu_search", execute);
      const before = vi.getTimerCount();
      await expect(wrapped.execute("cancelled", {}, caller.signal)).rejects.toThrow(
        "already cancelled",
      );
      expect(vi.getTimerCount()).toBe(before);
      expect(execute).not.toHaveBeenCalled();
      await wrapped.execute("allowed", {});
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
  it("keeps a caller-cancelled source promise in drain until its actual settlement", async () => {
    const deferred = createDeferredCore<typeof result>();
    const started = createDeferredCore();
    const caller = new AbortController();
    const pending = budget({}, caller).run(async () => {
      const wrapped = wrapToolWithAbortSignal(
        tool("read", async () => {
          started.resolve();
          return await deferred.promise;
        }),
        caller.signal,
      );
      await wrapped.execute("cancelled", {});
    });
    const rejected = expect(pending).rejects.toThrow();
    await started.promise;
    caller.abort(new Error("synthetic caller cancellation"));
    await rejected;
    expect(getTimerRequestCount()).toBe(0);
    expect(createGatewayActiveWorkSnapshot().counts.actualToolExecutions).toBe(1);
    deferred.resolve(result);
    await deferred.promise;
    await new Promise<void>((resolve) => {
      queueMicrotask(() => queueMicrotask(resolve));
    });
  });
  it("shortens a search to the remaining research window", async () => {
    vi.useFakeTimers();
    const deferred = createDeferredCore<typeof result>();
    await budget({ remainingMs: 130000 }).run(async () => {
      const pending = tool("baidu_search", () => deferred.promise).execute("short", {});
      const rejected = expect(pending).rejects.toThrow("research tool budget");
      await vi.advanceTimersByTimeAsync(10000);
      await rejected;
      expect(getActualToolExecutionCount()).toBe(1);
      deferred.resolve(result);
      await vi.advanceTimersByTimeAsync(0);
    });
  });
  it.each([480000, 240000])(
    "includes queued time in the %i millisecond total and fences retained closures",
    async (remainingMs) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const release = createDeferredCore();
      const started = createDeferredCore();
      const first = enqueueCommandInLane("timer-budget-fifo", async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      const deadline = vi.fn();
      let retained: ReturnType<typeof captureTimerToolExecution> | undefined;
      const execute = vi.fn<AnyAgentTool["execute"]>(async () => result);
      const queued = budget({ remainingMs }, controller, deadline).run(async () => {
        retained = captureTimerToolExecution();
        return await enqueueCommandInLane("timer-budget-fifo", async () =>
          tool("read", execute).execute("queued", {}),
        );
      });
      const rejected = expect(queued).rejects.toThrow("total execution budget");
      await vi.advanceTimersByTimeAsync(remainingMs);
      expect(controller.signal.aborted).toBe(true);
      expect(deadline).toHaveBeenCalledOnce();
      release.resolve();
      await first;
      await rejected;
      await expect(
        retained!.execute("read", undefined, async () => execute("retained", {})),
      ).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("does not count discovery as a search but still enforces the reserve", async () => {
    await budget({ maxSearchCalls: 0 }).run(async () => {
      await tool("tool_search").execute("discovery", {});
      await expect(tool("tavily_search").execute("search", {})).rejects.toThrow(
        "search-call budget",
      );
    });
  });
});
