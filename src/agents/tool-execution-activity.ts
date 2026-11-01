import { randomUUID } from "node:crypto";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const TOOL_DRAIN_PROTOCOL = "tool-drain-v1";

// Maintenance observes actual work independently of any task's budget policy.
const activity = resolveGlobalSingleton(Symbol.for("openclaw.toolExecutionActivity"), () => ({
  ownerEpoch: randomUUID(),
  tools: 0,
  requests: 0,
}));

export function getExecutionActivityOwnerEpoch() {
  return activity.ownerEpoch;
}

export function getActualToolExecutionCount() {
  return activity.tools;
}

export function getTimerRequestCount() {
  return activity.requests;
}

/** Invoke synchronously; retain activity until the source Promise actually settles. */
export async function trackExecutionActivity<T>(
  kind: "tools" | "requests",
  run: () => Promise<T>,
): Promise<T> {
  activity[kind] += 1;
  try {
    return await run();
  } finally {
    activity[kind] -= 1;
  }
}
