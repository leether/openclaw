import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  fixtureCatalogId,
  fixtureToolCallId,
  fixtureToolName,
  fixtureToolText,
  planInstalledModelResponse,
} from "../../scripts/fork-linux/installed-model-fixture.mjs";

const tools = [
  {
    type: "function",
    function: {
      name: "tool_call",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, args: { type: "object" } },
        required: ["id"],
      },
    },
  },
];
const user = { role: "user", content: "PROVE_ACTUAL_TOOL" };
function terminalConversation(): { tools: typeof tools; messages: Record<string, unknown>[] } {
  const { message } = planInstalledModelResponse({ tools, messages: [user] });
  return {
    tools,
    messages: [
      user,
      message,
      {
        role: "tool",
        tool_call_id: fixtureToolCallId,
        content: JSON.stringify({
          tool: { id: fixtureCatalogId, name: fixtureToolName, source: "openclaw" },
          result: {
            content: [{ type: "text", text: fixtureToolText }],
            details: { status: "completed", fixture: "timer-source-v1" },
          },
        }),
      },
    ],
  };
}

describe("installed-package synthetic model protocol", () => {
  it("uses the advertised dispatcher and exact known target without discovering or retrying", () => {
    const response = planInstalledModelResponse({ tools, messages: [user] });
    expect(response).toMatchObject({ action: "call", reason: "tool_calls" });
    assert.ok("tool_calls" in response.message);
    expect(response.message.tool_calls).toEqual([
      {
        id: fixtureToolCallId,
        type: "function",
        function: {
          name: "tool_call",
          arguments: JSON.stringify({ id: fixtureToolName, args: {} }),
        },
      },
    ]);
    expect(
      planInstalledModelResponse({
        tools,
        messages: [{ role: "user", content: [{ type: "text", text: user.content }] }],
      }),
    ).toEqual(response);
  });
  it("requires the matching call and source's structured success before answering", () => {
    expect(planInstalledModelResponse(terminalConversation())).toMatchObject({
      action: "completed",
      reason: "stop",
      message: { content: "SYNTHETIC_TIMER_OK" },
    });
  });
  it("does not require tools for the simple protocol-only answer", () => {
    expect(
      planInstalledModelResponse({ messages: [{ role: "user", content: "simple" }] }),
    ).toMatchObject({ action: "answer", reason: "stop" });
  });
  it("rejects a missing or incompatible advertised control", () => {
    expect(() => planInstalledModelResponse({ messages: [user] })).toThrow("advertised");
    const incompatible = structuredClone(tools);
    assert.ok(incompatible[0]);
    incompatible[0].function.parameters.required = [];
    expect(() => planInstalledModelResponse({ tools: incompatible, messages: [user] })).toThrow();
  });
  it("never resends an outstanding call", () => {
    const input = terminalConversation();
    input.messages.pop();
    expect(() => planInstalledModelResponse(input)).toThrow("outstanding");
  });
  it.each([
    "unknown tool timer_fixture_tool",
    JSON.stringify({ error: "budget exhausted" }),
    JSON.stringify({
      tool: { id: fixtureCatalogId, name: fixtureToolName, source: "openclaw" },
      result: { isError: true, content: [{ type: "text", text: fixtureToolText }] },
    }),
    JSON.stringify({
      tool: { id: "openclaw:other:timer_fixture_tool", name: fixtureToolName, source: "openclaw" },
      result: {
        content: [{ type: "text", text: fixtureToolText }],
        details: { status: "completed", fixture: "timer-source-v1" },
      },
    }),
  ])("fails immediately on an invalid tool terminal: %s", (content) => {
    const input = terminalConversation();
    assert.ok(input.messages[2]);
    input.messages[2].content = content;
    expect(() => planInstalledModelResponse(input)).toThrow();
  });
  it("rejects unrelated and duplicate result IDs even with success content", () => {
    const input = terminalConversation();
    assert.ok(input.messages[2]);
    input.messages[2].tool_call_id = "other-call";
    expect(() => planInstalledModelResponse(input)).toThrow();
    const duplicate = terminalConversation();
    assert.ok(duplicate.messages[2]);
    duplicate.messages.push(duplicate.messages[2]);
    expect(() => planInstalledModelResponse(duplicate)).toThrow("one matching");
  });
  it.each([
    {
      id: "other-call",
      name: "tool_call",
      arguments: JSON.stringify({ id: fixtureToolName, args: {} }),
    },
    { id: fixtureToolCallId, name: fixtureToolName, arguments: "{}" },
    {
      id: fixtureToolCallId,
      name: "tool_call",
      arguments: JSON.stringify({ id: "other-target", args: {} }),
    },
  ])("rejects a mismatched originating invocation %j", ({ id, ...func }) => {
    const input = terminalConversation();
    input.messages[1] = {
      role: "assistant",
      tool_calls: [{ id, type: "function", function: func }],
    };
    expect(() => planInstalledModelResponse(input)).toThrow();
  });
});
