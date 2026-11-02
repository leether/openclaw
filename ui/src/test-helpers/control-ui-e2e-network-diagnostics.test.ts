import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Page, Request, Response } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  installControlUiE2ePageDiagnosticRing,
} from "./control-ui-e2e-diagnostics.ts";
import {
  createControlUiNetworkDiagnostics,
  type ControlUiNetworkEvent,
  type ControlUiNetworkSnapshot,
} from "./control-ui-e2e-network-diagnostics.ts";

function request(resourceType = "script") {
  const forbidden = vi.fn(() => {
    throw new Error("Raw request data was read");
  });
  const value = {
    resourceType: () => resourceType,
    url: forbidden,
    method: forbidden,
    headers: forbidden,
    postData: forbidden,
    failure: forbidden,
  } as unknown as Request;
  return { value, forbidden };
}
function response(value: Request, status = 200) {
  return { request: () => value, status: () => status } as Response;
}
function fixture() {
  const events: ControlUiNetworkEvent[] = [];
  const owner = createControlUiNetworkDiagnostics({
    record: (event) => events.push(event),
    readEvents: () => events,
  });
  return { owner, events };
}

describe("bounded page network evidence", () => {
  it("retains response-to-body pending and treats HTTP 503 as a response, not requestfailed", () => {
    const { owner } = fixture();
    const req = request();
    owner.request(req.value);
    expect(owner.snapshot()).toMatchObject({
      scope: "page-events-since-registration",
      navigationAssociation: "none",
      pendingTotal: 1,
      pendingLowerBound: 1,
      pending: [{ responseAtMs: null }],
    });
    owner.response(response(req.value, 503));
    expect(owner.snapshot()).toMatchObject({
      pendingTotal: 1,
      pending: [{ statusClass: "5xx", responseAtMs: expect.any(Number) }],
    });
    owner.finished(req.value);
    const result = owner.snapshot();
    expect(result).toMatchObject({ pendingTotal: 0, pendingLowerBound: 0, pending: [] });
    expect(result?.countsByType.find((entry) => entry.resourceType === "script")).toMatchObject({
      request: 1,
      response: 1,
      finished: 1,
      failed: 0,
    });
    expect(req.forbidden).not.toHaveBeenCalled();
  });

  it("records failure without response and maps an untrusted resource name to other", () => {
    const { owner } = fixture();
    const req = request("private-resource-name");
    owner.request(req.value);
    owner.failed(req.value);
    const result = owner.snapshot();
    expect(result).toMatchObject({
      pendingTotal: 0,
      recent: [
        { stage: "request", resourceType: "other" },
        { stage: "failed", resourceType: "other" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private-resource-name");
    expect(req.forbidden).not.toHaveBeenCalled();
  });

  it("releases terminal identity without rereading request metadata", () => {
    const { owner } = fixture();
    const resourceType = vi
      .fn()
      .mockReturnValueOnce("script")
      .mockImplementation(() => {
        throw new Error("late metadata unavailable");
      });
    const req = { resourceType } as unknown as Request;
    owner.request(req);
    owner.finished(req);
    expect(resourceType).toHaveBeenCalledOnce();
    expect(owner.snapshot()).toMatchObject({
      pendingTotal: 0,
      pendingLowerBound: 0,
      observationErrors: 0,
    });
  });

  it("does not infer complete zero after pending overflow or unmatched terminal events", () => {
    const { owner } = fixture();
    const requests = Array.from({ length: 65 }, () => request().value);
    for (const value of requests) {
      owner.request(value);
    }
    expect(owner.snapshot()).toMatchObject({
      pendingTotal: null,
      pendingLowerBound: 64,
      pendingOverflow: 1,
      pendingOmitted: 48,
    });
    owner.response(response(requests[64]!));
    for (const value of requests) {
      owner.finished(value);
    }
    expect(owner.snapshot()).toMatchObject({
      pendingTotal: null,
      pendingLowerBound: 0,
      pendingOverflow: 1,
      unmatchedEvents: 2,
    });
  });

  it("bounds the public event tail and preserves missing identity as incomplete", () => {
    const { owner } = fixture();
    for (let i = 0; i < 40; i += 1) {
      owner.finished(request().value);
    }
    const result = owner.snapshot();
    expect(result?.recent).toHaveLength(32);
    expect(result).toMatchObject({
      recentOmitted: 8,
      pendingTotal: null,
      pendingLowerBound: 0,
      unmatchedEvents: 40,
    });
    expect(result?.recent.every((event) => event.requestId === null)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThanOrEqual(16_384);
  });

  it("contains getter, recorder, and snapshot-reader failures without inventing complete evidence", () => {
    const owner = createControlUiNetworkDiagnostics({
      record: () => {
        throw new Error("private recorder error");
      },
      readEvents: () => {
        throw new Error("private reader error");
      },
    });
    const broken = {
      resourceType: () => {
        throw new Error("private getter error");
      },
    } as unknown as Request;
    expect(() => owner.request(broken)).not.toThrow();
    const req = request();
    expect(() => owner.request(req.value)).not.toThrow();
    const result = owner.snapshot();
    expect(result).toMatchObject({
      pendingTotal: null,
      pendingLowerBound: 1,
      observationErrors: 3,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});

describe("network diagnostic listener owner", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const cleanups: Array<() => void> = [];
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    try {
      for (const close of cleanups.splice(0)) {
        close();
      }
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
  function pageFixture() {
    const parent = tempDirs.make("control-ui-network-diagnostics-");
    vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", parent);
    let closed = false;
    let connected = true;
    const browser = Object.assign(new EventEmitter(), { isConnected: () => connected });
    const events = new EventEmitter();
    // Only renderer plumbing is synthetic; network facts come from real listener callbacks.
    const evaluate = vi.fn(async () => ({ failureSummary: { available: true } }));
    const page = Object.assign(events, {
      context: () => ({ browser: () => browser }),
      isClosed: () => closed,
      frames: () => [],
      url: () => "http://127.0.0.1/chat",
      evaluate,
      screenshot: async () => Buffer.from("synthetic"),
    }) as unknown as Page;
    const ring = installControlUiE2ePageDiagnosticRing(page);
    const close = () => {
      closed = true;
      events.emit("close");
    };
    cleanups.push(close);
    const disconnect = () => {
      connected = false;
      browser.emit("disconnected");
    };
    const readReport = (before: Set<string>) => {
      const added = readdirSync(parent).filter((name) => !before.has(name));
      expect(added).toHaveLength(1);
      const text = readFileSync(path.join(parent, added[0]!, "failure.public.json"), "utf8");
      const value = JSON.parse(text) as { networkBeforeRead: ControlUiNetworkSnapshot | null };
      return { text, value: value.networkBeforeRead };
    };
    const capture = async () => {
      const before = new Set(readdirSync(parent));
      await captureControlUiE2eFailureDiagnostics(page, {
        error: new Error("synthetic"),
        label: "network",
      });
      return readReport(before);
    };
    return {
      page,
      events,
      browser,
      ring,
      close,
      disconnect,
      evaluate,
      capture,
      parent,
      readReport,
    };
  }

  it("uses the existing 200-entry ring and does not promote private requestfailed fields", async () => {
    const owner = pageFixture();
    for (let i = 0; i < 100; i += 1) {
      const req = request();
      owner.events.emit("request", req.value);
      owner.events.emit("response", response(req.value));
      owner.events.emit("requestfinished", req.value);
    }
    const failed = {
      resourceType: () => "image",
      method: () => "GET",
      url: () => "https://private.invalid/path?secret=hidden",
      failure: () => ({ errorText: "private error text" }),
    } as Request;
    owner.events.emit("request", failed);
    owner.events.emit("requestfailed", failed);
    expect(owner.ring).toHaveLength(200);
    expect(owner.ring.at(-1)).toMatchObject({
      source: "requestfailed",
      details: { errorText: "private error text" },
    });
    const result = await owner.capture();
    expect(result.value).toMatchObject({ pendingTotal: 0, pendingLowerBound: 0 });
    expect(result.value?.ringEvictedEvents).toBeGreaterThan(0);
    expect(result.value?.recent).toHaveLength(32);
    expect(
      result.value?.countsByType.find((entry) => entry.resourceType === "script"),
    ).toMatchObject({ request: 100, response: 100, finished: 100, failed: 0 });
    expect(result.text).not.toMatch(/private\.invalid|secret=|private error text/);
  });

  it("freezes host pending facts before the renderer diagnostic Promise returns", async () => {
    const owner = pageFixture();
    const held = createDeferredCore<{ failureSummary: { available: boolean } }>();
    owner.evaluate.mockImplementationOnce(() => held.promise);
    const req = request();
    owner.events.emit("request", req.value);
    const before = new Set(readdirSync(owner.parent));
    const capture = captureControlUiE2eFailureDiagnostics(owner.page, {
      error: new Error("synthetic"),
      label: "network",
    });
    const joined = Promise.allSettled([capture]);
    try {
      owner.events.emit("requestfinished", req.value);
      held.resolve({ failureSummary: { available: true } });
      await capture;
      expect(owner.readReport(before).value).toMatchObject({
        pendingTotal: 1,
        pendingLowerBound: 1,
      });
      expect((await owner.capture()).value).toMatchObject({
        pendingTotal: 0,
        pendingLowerBound: 0,
      });
    } finally {
      held.resolve({ failureSummary: { available: true } });
      await joined;
    }
  });

  it.each(["page-close", "browser-disconnect"] as const)(
    "retires listeners and pending identity on %s without fabricating completion",
    async (reason) => {
      const owner = pageFixture();
      owner.events.emit("request", request().value);
      expect(installControlUiE2ePageDiagnosticRing(owner.page)).toBe(owner.ring);
      expect(owner.events.listenerCount("request")).toBe(1);
      if (reason === "page-close") {
        owner.close();
      } else {
        owner.disconnect();
      }
      for (const event of ["request", "response", "requestfinished"]) {
        expect(owner.events.listenerCount(event)).toBe(0);
      }
      const frozen = (await owner.capture()).value;
      expect(frozen).toMatchObject({
        active: false,
        retiredReason: reason,
        pendingTotal: null,
        pendingLowerBound: null,
        lastObservedPendingLowerBound: 1,
      });
      owner.events.emit("requestfinished", request().value);
      expect((await owner.capture()).value).toEqual(frozen);
      owner.close();
      expect(owner.events.listenerCount("requestfailed")).toBe(0);
      expect(owner.browser.listenerCount("disconnected")).toBe(0);
    },
  );
});
