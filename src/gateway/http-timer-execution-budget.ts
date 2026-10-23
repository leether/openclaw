import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createTimerExecutionBudget,
  parseTimerExecutionBudgetHeader,
  TIMER_BUDGET_PROTOCOL,
} from "../agents/timer-execution-budget.js";
import { sendInvalidRequest, sendJson } from "./http-common.js";

/** Called only after the HTTP endpoint has authenticated and bounded its JSON intake. */
export async function runWithHttpTimerExecutionBudget(
  req: IncomingMessage,
  res: ServerResponse,
  run: (abortController: AbortController, budgetAccepted: boolean) => Promise<boolean>,
): Promise<boolean> {
  const abortController = new AbortController();
  let budgetSpec;
  try {
    budgetSpec = parseTimerExecutionBudgetHeader(req.headers["x-openclaw-timer-budget"]);
  } catch {
    sendInvalidRequest(res, "Invalid timer budget or Gateway owner changed");
    return true;
  }
  const timerBudget = budgetSpec
    ? createTimerExecutionBudget(budgetSpec, abortController, () => {
        if (!res.headersSent) {
          sendJson(res, 504, {
            error: { message: "Timer total execution budget exhausted", type: "timeout_error" },
          });
        } else if (!res.writableEnded) {
          res.destroy(new Error("Timer total execution budget exhausted"));
        }
      })
    : undefined;
  if (timerBudget) {
    res.setHeader("x-openclaw-timer-budget", TIMER_BUDGET_PROTOCOL);
  }
  const execute = () => run(abortController, Boolean(timerBudget));
  return timerBudget ? await timerBudget.run(execute) : await execute();
}
