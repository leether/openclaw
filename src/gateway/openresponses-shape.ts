import type { ClientToolDefinition } from "../agents/command/shared-types.js";
import { toOpenAiResponsesUsage } from "../agents/usage.js";
import type {
  CreateResponseBody,
  OutputItem,
  ResponseResource,
  Usage,
} from "./open-responses.schema.js";
import { resolveAgentRunUsage } from "./openai-agent-run-usage.js";

export function createAssistantOutputItem(params: {
  id: string;
  text: string;
  phase?: "commentary" | "final_answer";
  status?: "in_progress" | "completed" | "incomplete";
}): Extract<OutputItem, { type: "message" }> {
  return {
    type: "message",
    id: params.id,
    role: "assistant",
    content: [{ type: "output_text", text: params.text }],
    ...(params.phase ? { phase: params.phase } : {}),
    status: params.status,
  };
}

export function createFunctionCallOutputItem(params: {
  id: string;
  callId: string;
  name: string;
  arguments: string;
  status?: "in_progress" | "completed";
}): Extract<OutputItem, { type: "function_call" }> {
  return {
    type: "function_call",
    id: params.id,
    call_id: params.callId,
    name: params.name,
    arguments: params.arguments,
    status: params.status,
  };
}

export function createResponseResource(params: {
  id: string;
  createdAt: number;
  model: string;
  status: ResponseResource["status"];
  output: OutputItem[];
  usage?: Usage;
  error?: { code: string; message: string };
}): ResponseResource {
  return {
    id: params.id,
    object: "response",
    created_at: params.createdAt,
    status: params.status,
    model: params.model,
    output: params.output,
    usage: params.usage ?? toOpenAiResponsesUsage(undefined),
    error: params.error,
    ...(params.status === "incomplete"
      ? { incomplete_details: { reason: "max_output_tokens" as const } }
      : {}),
  };
}

export function extractClientTools(body: CreateResponseBody): ClientToolDefinition[] {
  // Normalize from Responses API flat format to the internal wrapped format.
  return (body.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    },
  }));
}

export function extractUsageFromResult(result: unknown): Usage {
  return toOpenAiResponsesUsage(resolveAgentRunUsage(result));
}
