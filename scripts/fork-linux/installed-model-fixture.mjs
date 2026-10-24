// Pure synthetic-model protocol used by the installed-package qualification.
import assert from "node:assert/strict";

export const fixtureToolCallId = "synthetic-tool-call";
export const fixtureToolName = "timer_fixture_tool";
export const fixtureCatalogId = `openclaw:timer-fixture:${fixtureToolName}`;
export const fixtureSourceCallId = `tool_call:${fixtureToolCallId}:${fixtureToolName}:1`;
export const fixtureToolText = "synthetic tool completed";
const callArguments = { id: fixtureToolName, args: {} };
const answer = { role: "assistant", content: "SYNTHETIC_TIMER_OK" };

export function planInstalledModelResponse(input) {
  assert.ok(Array.isArray(input.messages), "synthetic model messages required");
  const needsTool = input.messages.some((message) => {
    if (message.role !== "user") {
      return false;
    }
    const text = Array.isArray(message.content)
      ? message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : message.content;
    return typeof text === "string" && text.includes("PROVE_ACTUAL_TOOL");
  });
  if (!needsTool) {
    return { message: answer, reason: "stop", action: "answer" };
  }
  const controls = input.tools?.filter(
    (tool) => tool.type === "function" && tool.function?.name === "tool_call",
  );
  assert.equal(controls?.length, 1, "actual advertised tool_call control required");
  const schema = controls[0].function.parameters;
  assert.equal(schema?.type, "object");
  assert.equal(schema.properties?.id?.type, "string");
  assert.equal(schema.properties?.args?.type, "object");
  assert.ok(schema.required?.includes("id"), "tool_call id must be required");
  const calls = input.messages.flatMap((message) =>
    message.role === "assistant" ? (message.tool_calls ?? []) : [],
  );
  const terminals = input.messages.filter((message) => message.role === "tool");
  if (!terminals.length) {
    assert.equal(calls.length, 0, "do not repeat an outstanding synthetic tool call");
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: fixtureToolCallId,
            type: "function",
            function: { name: "tool_call", arguments: JSON.stringify(callArguments) },
          },
        ],
      },
      reason: "tool_calls",
      action: "call",
    };
  }
  assert.equal(calls.length, 1, "exactly one synthetic control invocation required");
  assert.equal(calls[0].id, fixtureToolCallId);
  assert.equal(calls[0].function?.name, "tool_call");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), callArguments);
  assert.equal(terminals.length, 1, "exactly one matching tool terminal required");
  assert.equal(terminals[0].tool_call_id, fixtureToolCallId);
  const terminal = JSON.parse(terminals[0].content);
  assert.equal(terminal.tool?.name, fixtureToolName);
  assert.equal(terminal.tool?.source, "openclaw");
  assert.equal(terminal.tool?.id, fixtureCatalogId);
  assert.notEqual(terminal.result?.isError, true, "tool error is not a successful answer");
  assert.deepEqual(terminal.result?.details, { status: "completed", fixture: "timer-source-v1" });
  assert.deepEqual(terminal.result?.content, [{ type: "text", text: fixtureToolText }]);
  return { message: answer, reason: "stop", action: "completed" };
}
