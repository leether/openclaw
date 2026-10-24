import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.wrapper.js";
import type { AnyAgentTool } from "../agents/agent-tools.types.js";
import {
  getTimerBudgetCapabilities,
  getTimerRequestCount,
} from "../agents/timer-execution-budget.js";
import {
  agentCommandMock,
  getGatewayTestPort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
let gateway: Awaited<ReturnType<typeof startGatewayServerWithRetries>>;
beforeAll(async () => {
  gateway = await startGatewayServerWithRetries({
    port: await getGatewayTestPort(),
    opts: {
      host: "127.0.0.1",
      auth: { mode: "none" },
      controlUiEnabled: false,
      openResponsesEnabled: true,
    },
  });
});
afterAll(async () => {
  await gateway?.server.close({ reason: "timer budget contract fixture complete" });
});
async function post(body: Record<string, unknown> = {}, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
      ...headers,
    },
    body: JSON.stringify({ model: "openclaw", input: "hi", ...body }),
  });
}

describe("authenticated timer budget HTTP contract", () => {
  const headers = (remainingMs = 480000, extra = {}) => ({
    "x-openclaw-timer-budget": JSON.stringify({
      version: "timer-budget-v1",
      remainingMs,
      answerReserveMs: 120000,
      maxSearchCalls: 4,
      searchCallTimeoutMs: 45000,
      expectedOwnerEpoch: getTimerBudgetCapabilities().ownerEpoch,
      ...extra,
    }),
  });
  it("rejects a stale owner before dispatch", async () => {
    agentCommandMock.mockClear();
    const response = await post({}, headers(480000, { expectedOwnerEpoch: "previous-process" }));
    expect(response.status).toBe(400);
    expect(agentCommandMock).not.toHaveBeenCalled();
    await response.text();
  });
  it.each([480000, 240000])(
    "acknowledges %i and propagates the owner to the actual tool wrapper",
    async (remainingMs) => {
      const execute = vi.fn<AnyAgentTool["execute"]>(async () => ({
        content: [{ type: "text" as const, text: "fixture" }],
        details: {},
      }));
      agentCommandMock.mockImplementationOnce(async () => {
        const wrapped = wrapToolWithBeforeToolCallHook({
          name: "baidu_web_search",
          label: "search",
          description: "fixture",
          parameters: Type.Object({ freshness: Type.String() }),
          execute,
        });
        await wrapped.execute("fixture", { freshness: "month" });
        return { payloads: [{ text: "synthetic answer" }] } as never;
      });
      const response = await post({}, headers(remainingMs));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-openclaw-timer-budget")).toBe("timer-budget-v1");
      expect(execute.mock.calls[0]?.[1]).toEqual({ freshness: "pm" });
      await response.text();
    },
  );
  it("keeps an SSE owner alive until actual agent completion", async () => {
    const release = createDeferred();
    const started = createDeferred();
    agentCommandMock.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return { payloads: [{ text: "synthetic streamed answer" }] } as never;
    });
    const responsePromise = post({ stream: true }, headers());
    await started.promise;
    const response = await responsePromise;
    expect(response.headers.get("x-openclaw-timer-budget")).toBe("timer-budget-v1");
    expect(getTimerRequestCount()).toBe(1);
    release.resolve();
    expect(await response.text()).toContain("synthetic streamed answer");
    expect(getTimerRequestCount()).toBe(0);
  });
  it("cuts off the HTTP response at the total deadline while retaining unsettled work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const release = createDeferred();
    const started = createDeferred();
    agentCommandMock.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return { payloads: [{ text: "late fixture" }] } as never;
    });
    try {
      const responsePromise = post({}, headers(10000));
      await started.promise;
      await vi.advanceTimersByTimeAsync(10000);
      const response = await responsePromise;
      expect(response.status).toBe(504);
      expect(getTimerRequestCount()).toBe(1);
      await response.text();
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(getTimerRequestCount()).toBe(0);
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });
  it("leaves a request without a budget on the existing path", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "legacy fixture" }] } as never);
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-openclaw-timer-budget")).toBeNull();
    await response.text();
  });
});
