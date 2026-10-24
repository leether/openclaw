import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getTimerBudgetCapabilities,
  parseTimerExecutionBudgetHeader,
} from "../agents/timer-execution-budget.js";
import {
  agentCommandMock,
  getGatewayTestPort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
} from "./test-helpers.js";

// Explicit cross-repository qualification: ordinary source CI has no Bridge checkout.
// BRIDGE_SOURCE=/path/to/bridge node scripts/run-vitest.mjs <this-file>
describe.skipIf(!process.env.BRIDGE_SOURCE)("external Bridge wire qualification", () => {
  installGatewayTestHooks({ scope: "suite" });
  let started: Awaited<ReturnType<typeof startGatewayServerWithRetries>>;
  beforeAll(async () => {
    started = await startGatewayServerWithRetries({
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
    await started?.server.close({ reason: "isolated wire contract fixture complete" });
  });
  it("accepts actual Bridge timer rail wire headers through native parser and real HTTP ingress", async () => {
    const bridgeSource = process.env.BRIDGE_SOURCE;
    if (!bridgeSource) {
      throw new Error("This private cross-repository proof requires BRIDGE_SOURCE");
    }
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        path.join(bridgeSource, "test/timer-budget-wire.mjs"),
        getTimerBudgetCapabilities().ownerEpoch,
      ],
      { cwd: bridgeSource, timeout: 20000, maxBuffer: 32768 },
    );
    const fixtures = JSON.parse(stdout) as Array<{
      policy: { totalMs?: number; maxSearchCalls?: number };
      header: string;
    }>;
    expect(fixtures).toHaveLength(3);
    for (const fixture of fixtures) {
      expect(parseTimerExecutionBudgetHeader(fixture.header)).toMatchObject({
        remainingMs: fixture.policy.totalMs ?? 480000,
        maxSearchCalls: fixture.policy.maxSearchCalls ?? 4,
      });
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "synthetic cross-repo answer" }],
      } as never);
      const response = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openclaw-scopes": "operator.write",
          "x-openclaw-timer-budget": fixture.header,
        },
        body: JSON.stringify({ model: "openclaw", input: "synthetic wire fixture" }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-openclaw-timer-budget")).toBe("timer-budget-v1");
      expect(await response.text()).toContain("synthetic cross-repo answer");
    }
  });
});
