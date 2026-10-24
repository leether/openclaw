import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  ErrorCodes,
  readMissingScopeErrorDetails,
} from "../../../../packages/gateway-protocol/src/gateway-error-details.js";
import type { ResponseFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { isRetryableGatewayStartupUnavailableError } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import type { desktopNodeAdmissionFailure } from "../../../../scripts/lib/desktop-resize-proof.mts";
import { isOperatorScope } from "../../../../src/gateway/operator-scopes.js";

export type SkillLibraryNodeAdmissionFailure = ReturnType<typeof desktopNodeAdmissionFailure>;
export type SkillLibraryNodeAdmissionStage = SkillLibraryNodeAdmissionFailure["stage"];

/** The method comes from the locally matched pending request, never the response payload. */
export class SkillLibraryWireError extends Error {
  constructor(
    readonly error: NonNullable<ResponseFrame["error"]>,
    readonly method: string,
  ) {
    super(error.message);
  }
}

export function readSkillLibraryNodeAdmissionFailure(
  error: unknown,
  stage: SkillLibraryNodeAdmissionStage,
): SkillLibraryNodeAdmissionFailure | null {
  if (!(error instanceof SkillLibraryWireError)) {
    return null;
  }
  const wire = error.error;
  const missing = readMissingScopeErrorDetails(wire.details);
  const missingScope = missing?.missingScope;
  const category =
    missing && (wire.code === ErrorCodes.INVALID_REQUEST || wire.code === ErrorCodes.FORBIDDEN)
      ? "missing-scope"
      : isRetryableGatewayStartupUnavailableError(wire)
        ? "startup-unavailable"
        : wire.code === ErrorCodes.INVALID_REQUEST && wire.message === "unknown requestId"
          ? "unknown-request-id"
          : wire.code === ErrorCodes.UNAVAILABLE &&
              readConnectErrorDetailCode(wire.details) ===
                ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE
            ? "authenticated-profile-unavailable"
            : "other";
  return {
    stage,
    method:
      (["node.list", "node.pair.list", "node.pair.approve"] as const).find(
        (method) => method === error.method,
      ) ?? "other",
    outcome: "rpc-error",
    code: Object.values(ErrorCodes).find((code) => code === wire.code) ?? "other",
    category,
    retryable: typeof wire.retryable === "boolean" ? wire.retryable : null,
    missingScope:
      category === "missing-scope" && isOperatorScope(missingScope) ? missingScope : null,
  };
}

/** Optional synchronous diagnostics cannot replace the startup failure or prevent cleanup. */
export function reportSkillLibraryNodeAdmissionFailure(
  error: unknown,
  stage: SkillLibraryNodeAdmissionStage,
  report?: (failure: SkillLibraryNodeAdmissionFailure) => void,
): void {
  if (!report) {
    return;
  }
  try {
    const failure = readSkillLibraryNodeAdmissionFailure(error, stage);
    if (failure) {
      report(failure);
    }
  } catch {
    // The existing caller still owns the original error and mandatory process cleanup.
  }
}
