import type { Request, Response } from "playwright";

const PENDING_LIMIT = 64;
const RECENT_LIMIT = 32;
const PROJECTION_BYTES = 16_384;
const resourceTypes = [
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "texttrack",
  "xhr",
  "fetch",
  "eventsource",
  "websocket",
  "manifest",
  "other",
] as const;
type ResourceType = (typeof resourceTypes)[number];
type Stage = "request" | "response" | "finished" | "failed";
type StatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "other";
export type ControlUiNetworkEvent = {
  stage: Stage;
  requestId: number | null;
  resourceType: ResourceType;
  atMs: number;
  statusClass: StatusClass | null;
};
type Pending = {
  requestId: number;
  resourceType: ResourceType;
  startedAtMs: number;
  responseAtMs: number | null;
  statusClass: StatusClass | null;
};
type Counts = {
  resourceType: ResourceType;
  request: number;
  response: number;
  finished: number;
  failed: number;
};
export type ControlUiNetworkSnapshot = {
  scope: "page-events-since-registration";
  navigationAssociation: "none";
  active: boolean;
  retiredReason: "page-close" | "browser-disconnect" | null;
  capturedAtMs: number | null;
  countsByType: Counts[];
  pendingTotal: number | null;
  pendingLowerBound: number | null;
  lastObservedPendingLowerBound: number | null;
  pendingOverflow: number;
  unmatchedEvents: number;
  duplicateStarts: number;
  observationErrors: number;
  counterSaturated: boolean;
  ringEvictedEvents: number;
  recentOmitted: number;
  projectionTruncated: boolean;
  pendingOmitted: number;
  pending: Pending[];
  recent: ControlUiNetworkEvent[];
};

/** Synchronous observation only. Request identity never becomes a public URL or navigation ID. */
export function createControlUiNetworkDiagnostics(options: {
  record: (event: ControlUiNetworkEvent) => void;
  readEvents: () => readonly ControlUiNetworkEvent[];
}) {
  const registeredAt = performance.now();
  const counts = resourceTypes.map((resourceType): Counts => ({
    resourceType,
    request: 0,
    response: 0,
    finished: 0,
    failed: 0,
  }));
  const pending = new Map<number, Pending>();
  let identities = new WeakMap<Request, number>();
  let record: typeof options.record | null = options.record;
  let readEvents: typeof options.readEvents | null = options.readEvents;
  let sequence = 0;
  let pendingOverflow = 0;
  let unmatchedEvents = 0;
  let duplicateStarts = 0;
  let observationErrors = 0;
  let ringEvictedEvents = 0;
  let counterSaturated = false;
  let retired: ControlUiNetworkSnapshot | null = null;
  let closed = false;
  const increment = (value: number) => {
    if (value === Number.MAX_SAFE_INTEGER) {
      counterSaturated = true;
      return value;
    }
    return value + 1;
  };
  const now = () => {
    const value = Math.round(performance.now() - registeredAt);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Invalid diagnostic clock");
    }
    return value;
  };
  const observe = (stage: Stage, value: Request | Response) => {
    if (closed) {
      return;
    }
    try {
      const request = stage === "response" ? (value as Response).request() : (value as Request);
      let requestId = identities.get(request) ?? null;
      let entry = requestId === null ? undefined : pending.get(requestId);
      // Terminal identity release cannot depend on a metadata getter or clock succeeding.
      if (entry && (stage === "finished" || stage === "failed")) {
        pending.delete(entry.requestId);
        identities.delete(request);
      }
      const rawType = entry?.resourceType ?? request.resourceType();
      const resourceType = resourceTypes.find((type) => type === rawType) ?? "other";
      const bucket = counts.find((bucketEntry) => bucketEntry.resourceType === resourceType)!;
      bucket[stage] = increment(bucket[stage]);
      const atMs = now();
      let statusClass: StatusClass | null = null;
      if (stage === "request") {
        if (entry) {
          duplicateStarts = increment(duplicateStarts);
        } else if (pending.size < PENDING_LIMIT && sequence < Number.MAX_SAFE_INTEGER) {
          sequence += 1;
          requestId = sequence;
          entry = {
            requestId,
            resourceType,
            startedAtMs: atMs,
            responseAtMs: null,
            statusClass: null,
          };
          identities.set(request, requestId);
          pending.set(requestId, entry);
        } else {
          pendingOverflow = increment(pendingOverflow);
          counterSaturated ||= sequence === Number.MAX_SAFE_INTEGER;
          requestId = null;
        }
      } else {
        if (stage === "response") {
          const status = (value as Response).status();
          statusClass =
            Number.isInteger(status) && status >= 100 && status < 600
              ? (["1xx", "2xx", "3xx", "4xx", "5xx"][Math.floor(status / 100) - 1] as StatusClass)
              : "other";
        }
        if (!entry) {
          unmatchedEvents = increment(unmatchedEvents);
          requestId = null;
        } else if (stage === "response") {
          entry.responseAtMs ??= atMs;
          entry.statusClass = statusClass;
        }
      }
      record?.({ stage, requestId, resourceType, atMs, statusClass });
    } catch {
      observationErrors = increment(observationErrors);
    }
  };
  const boundProjection = (result: ControlUiNetworkSnapshot) => {
    // Bound only this new projection; existing private diagnostics retain their own contract.
    if (Buffer.byteLength(JSON.stringify(result, null, 2)) > PROJECTION_BYTES) {
      result.pendingTotal = null;
      result.projectionTruncated = true;
      result.pendingOmitted =
        result.pendingLowerBound ?? result.lastObservedPendingLowerBound ?? result.pending.length;
      result.pending = [];
      result.recent = [];
    }
    return result;
  };
  const snapshot = (): ControlUiNetworkSnapshot | null => {
    if (closed) {
      return retired;
    }
    let recent: ControlUiNetworkEvent[] = [];
    let capturedAtMs: number | null = null;
    let recentOmitted = 0;
    try {
      capturedAtMs = now();
      const events = readEvents?.() ?? [];
      recentOmitted = Math.max(0, events.length - RECENT_LIMIT);
      recent = events
        .slice(-RECENT_LIMIT)
        .map(({ stage, requestId, resourceType, atMs, statusClass }) => ({
          stage,
          requestId,
          resourceType,
          atMs,
          statusClass,
        }));
    } catch {
      observationErrors = increment(observationErrors);
    }
    const complete =
      pendingOverflow === 0 &&
      unmatchedEvents === 0 &&
      duplicateStarts === 0 &&
      observationErrors === 0 &&
      !counterSaturated;
    const result: ControlUiNetworkSnapshot = {
      scope: "page-events-since-registration",
      navigationAssociation: "none",
      active: true,
      retiredReason: null,
      capturedAtMs,
      countsByType: counts.map((entry) => ({
        resourceType: entry.resourceType,
        request: entry.request,
        response: entry.response,
        finished: entry.finished,
        failed: entry.failed,
      })),
      pendingTotal: complete ? pending.size : null,
      pendingLowerBound: pending.size,
      lastObservedPendingLowerBound: null,
      pendingOverflow,
      unmatchedEvents,
      duplicateStarts,
      observationErrors,
      counterSaturated,
      ringEvictedEvents,
      recentOmitted,
      projectionTruncated: false,
      pendingOmitted: Math.max(0, pending.size - 16),
      pending: [...pending.values()].slice(0, 16).map((entry) => ({
        requestId: entry.requestId,
        resourceType: entry.resourceType,
        startedAtMs: entry.startedAtMs,
        responseAtMs: entry.responseAtMs,
        statusClass: entry.statusClass,
      })),
      recent,
    };
    return boundProjection(result);
  };
  return {
    request: (request: Request) => observe("request", request),
    response: (response: Response) => observe("response", response),
    finished: (request: Request) => observe("finished", request),
    failed: (request: Request) => observe("failed", request),
    evicted: () => {
      if (!closed) {
        ringEvictedEvents = increment(ringEvictedEvents);
      }
    },
    snapshot,
    retire: (reason: "page-close" | "browser-disconnect") => {
      if (closed) {
        return;
      }
      try {
        const last = snapshot();
        if (!last) {
          return;
        }
        retired = boundProjection({
          ...last,
          active: false,
          retiredReason: reason,
          pendingTotal: null,
          pendingLowerBound: null,
          lastObservedPendingLowerBound: last.pendingLowerBound,
        });
      } finally {
        closed = true;
        pending.clear();
        identities = new WeakMap();
        record = null;
        readEvents = null;
      }
    },
  };
}
