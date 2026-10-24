import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.ts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  installControlUiE2ePageDiagnosticRing,
  recordControlUiE2eNavigation,
} from "./control-ui-e2e-diagnostics.ts";
import { waitForControlUiInitialRoster } from "./control-ui-e2e-readiness.ts";

type WaitInput = { attempt: number; navigationId: number | null };
type PublicFailure = {
  browser: {
    roster: { loading: boolean | null; count: number | null };
    sessionsReadiness: {
      loading: boolean | null;
      resultPresent: boolean | null;
      resultCached: boolean | null;
      count: number | null;
      wait: {
        attempt: number | null;
        navigationId: number | null;
        phase: string | null;
        reason: string | null;
      } | null;
    };
  };
  lifecycle: {
    navigation: {
      id: number;
      phase: string;
      failed: boolean;
      nativeResolvedAt: string | null;
      failedAt: string | null;
    } | null;
    lastLoadObservedAt: string | null;
  };
};

function observedUpdate() {
  const entered = createDeferredCore();
  const settled = createDeferredCore<boolean>();
  // A thenable reports actual await admission; merely reading updateComplete does not.
  const promise: PromiseLike<boolean> = {
    then(onfulfilled, onrejected) {
      entered.resolve();
      return settled.promise.then(onfulfilled, onrejected);
    },
  };
  return { entered: entered.promise, promise, release: () => settled.resolve(true) };
}

function readinessDom() {
  const sessions = {
    loading: false,
    result: { sessions: [{ key: "private-session" }] },
    resultCached: false,
  };
  const context: {
    sessions?: { state: typeof sessions };
    agents: {
      state: {
        connected: boolean;
        agentsLoading: boolean;
        agentsList: { agents: { id: string }[] };
      };
    };
    gateway: { snapshot: { phase: string } };
  } = {
    sessions: { state: sessions },
    agents: {
      state: {
        connected: true,
        agentsLoading: false,
        agentsList: { agents: [{ id: "private-agent" }] },
      },
    },
    gateway: { snapshot: { phase: "connected" } },
  };
  const app = Object.assign(document.createElement("openclaw-app"), {
    hasUpdated: true,
    isUpdatePending: false,
    updateComplete: Promise.resolve(true) as PromiseLike<boolean>,
    runtime: { context },
  });
  const sidebar = Object.assign(document.createElement("aside"), {
    navigationVisible: true,
    hasUpdated: true,
    isUpdatePending: false,
    updateComplete: Promise.resolve(true) as PromiseLike<boolean>,
  });
  const shell = Object.assign(document.createElement("openclaw-app-shell"), {
    hasUpdated: true,
    isUpdatePending: false,
    updateComplete: Promise.resolve(true) as PromiseLike<boolean>,
    navigationSidebar: sidebar,
  });
  const content = document.createElement("div");
  content.className = "shell";
  content.append(sidebar);
  shell.append(content);
  app.append(shell);
  document.body.append(app);
  return { app, shell, sidebar, sessions, context };
}

describe("initial roster diagnostic ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
    vi.stubGlobal("__OPENCLAW_CONTROL_UI_E2E_ROSTER_READINESS__", undefined);
    vi.stubGlobal("openclawControlUiE2eGateway", { online: true, initialRosterDelivered: true });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
  });

  afterEach(() => {
    try {
      for (const close of cleanups.splice(0)) {
        close();
      }
    } finally {
      document.body.replaceChildren();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  function fixture(blockedWait?: Promise<never>) {
    const parent = tempDirs.make("control-ui-readiness-diagnostics-");
    vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", parent);
    const browser = Object.assign(new EventEmitter(), { isConnected: () => true });
    const events = new EventEmitter();
    const dispose = vi.fn();
    // SAFETY: execute the real serialized callback against this synthetic DOM. The
    // boundary does not reimplement its predicate or manufacture diagnostic state.
    const page = Object.assign(events, {
      context: () => ({ browser: () => browser }),
      isClosed: () => false,
      frames: () => [],
      url: () => "http://127.0.0.1/chat",
      evaluate: async (read: () => unknown) => read(),
      screenshot: async () => Buffer.from("synthetic-proof"),
      waitForFunction: async (
        predicate: (input: WaitInput) => boolean | Promise<boolean>,
        input: WaitInput,
      ) => {
        const admitted = await predicate(input);
        if (!admitted) {
          if (blockedWait) {
            return await blockedWait;
          }
          throw new Error("Unexpected blocked readiness fixture");
        }
        return { dispose };
      },
    }) as unknown as Page;
    installControlUiE2ePageDiagnosticRing(page);
    const close = () => events.emit("close");
    cleanups.push(close);
    const capture = async () => {
      const before = new Set(readdirSync(parent));
      await captureControlUiE2eFailureDiagnostics(page, {
        error: new Error("synthetic failure"),
        label: "readiness",
      });
      const added = readdirSync(parent).filter((name) => !before.has(name));
      expect(added).toHaveLength(1);
      const text = readFileSync(path.join(parent, added[0]!, "failure.public.json"), "utf8");
      return { text, value: JSON.parse(text) as PublicFailure };
    };
    return { page, events, dispose, close, capture };
  }

  it("keeps a newer same-document wait owned while the older render Promise completes", async ({
    signal,
  }) => {
    const dom = readinessDom();
    const first = observedUpdate();
    const second = observedUpdate();
    const owner = fixture();
    dom.app.updateComplete = first.promise;
    const waitA = waitForControlUiInitialRoster(owner.page, 41);
    dom.app.updateComplete = second.promise;
    const waitB = waitForControlUiInitialRoster(owner.page, 42);
    const joined = Promise.allSettled([waitA, waitB]);
    try {
      await withinTest(
        Promise.all([
          awaitGateBeforeSettlement(
            first.entered,
            waitA,
            "First wait never reached its render boundary",
          ),
          awaitGateBeforeSettlement(
            second.entered,
            waitB,
            "Second wait never reached its render boundary",
          ),
        ]),
        signal,
      );
      first.release();
      await waitA;
      expect((await owner.capture()).value.browser.sessionsReadiness.wait).toMatchObject({
        attempt: 2,
        navigationId: 42,
        phase: "app-update",
        reason: null,
      });
      second.release();
      await waitB;
      expect((await owner.capture()).value.browser.sessionsReadiness.wait).toMatchObject({
        attempt: 2,
        navigationId: 42,
        phase: "complete",
        reason: null,
      });
      expect(owner.dispose).toHaveBeenCalledTimes(2);
    } finally {
      first.release();
      second.release();
      await joined;
    }
  });

  for (const phase of ["shell-update", "sidebar-update", "animation-frame"] as const) {
    it(`reports the actually held ${phase} boundary before it settles`, async ({ signal }) => {
      const dom = readinessDom();
      const held = observedUpdate();
      const frameEntered = createDeferredCore();
      let frameReleased = false;
      let frameCallback: FrameRequestCallback | undefined;
      const releaseFrame = () => {
        frameReleased = true;
        frameCallback?.(0);
        frameCallback = undefined;
      };
      if (phase === "shell-update") {
        dom.shell.updateComplete = held.promise;
      } else if (phase === "sidebar-update") {
        dom.sidebar.updateComplete = held.promise;
      } else {
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
          frameCallback = callback;
          frameEntered.resolve();
          if (frameReleased) {
            releaseFrame();
          }
          return 1;
        });
      }
      const owner = fixture();
      const waiting = waitForControlUiInitialRoster(owner.page, 7);
      const joined = Promise.allSettled([waiting]);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            phase === "animation-frame" ? frameEntered.promise : held.entered,
            waiting,
            "Wait settled before reaching its held render boundary",
          ),
          signal,
        );
        expect((await owner.capture()).value.browser.sessionsReadiness.wait).toMatchObject({
          navigationId: 7,
          phase,
        });
        held.release();
        releaseFrame();
        await waiting;
        expect((await owner.capture()).value.browser.sessionsReadiness.wait?.phase).toBe(
          "complete",
        );
        expect(owner.dispose).toHaveBeenCalledOnce();
      } finally {
        held.release();
        releaseFrame();
        await joined;
      }
    });
  }

  it("distinguishes pending sessions from the ready Agent roster and retains unknowns", async () => {
    const dom = readinessDom();
    dom.sessions.loading = true;
    const blocked = createDeferredCore<never>();
    const owner = fixture(blocked.promise);
    const cause = new Error("synthetic original wait failure");
    const waiting = waitForControlUiInitialRoster(owner.page, 9);
    const joined = Promise.allSettled([waiting]);
    try {
      const summary = await owner.capture();
      expect(summary.value.browser.roster).toMatchObject({ loading: false, count: 1 });
      expect(summary.value.browser.sessionsReadiness).toMatchObject({
        loading: true,
        resultPresent: true,
        resultCached: false,
        count: 1,
        wait: { phase: "predicate", reason: "sessions-loading", navigationId: 9 },
      });
      expect(summary.text).not.toContain("private-agent");
      expect(summary.text).not.toContain("private-session");
      delete dom.context.sessions;
      expect((await owner.capture()).value.browser.sessionsReadiness).toMatchObject({
        loading: null,
        resultPresent: null,
        resultCached: null,
        count: null,
      });
      blocked.reject(cause);
      await expect(waiting).rejects.toMatchObject({ cause });
      const failure: unknown = await waiting.catch((error: unknown) => error);
      expect(failure instanceof Error && failure.cause).toBe(cause);
      expect(owner.dispose).not.toHaveBeenCalled();
    } finally {
      blocked.reject(cause);
      await joined;
    }
  });

  it.each(["native-resolved", "complete", "failed"] as const)(
    "does not attribute an older navigation's %s to the current navigation",
    async (event) => {
      readinessDom();
      const owner = fixture();
      const first = recordControlUiE2eNavigation(owner.page, "goto");
      const second = recordControlUiE2eNavigation(owner.page, "reload", { waitUntil: "commit" });
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
      const before = (await owner.capture()).value.lifecycle.navigation;
      expect(before).toMatchObject({ id: second, phase: "native-navigation", failed: false });
      expect(recordControlUiE2eNavigation(owner.page, event, { navigationId: first })).toBeNull();
      expect((await owner.capture()).value.lifecycle.navigation).toEqual(before);
      recordControlUiE2eNavigation(owner.page, "native-resolved", { navigationId: second });
      const current = (await owner.capture()).value.lifecycle.navigation;
      expect(current).toMatchObject({ id: second, phase: "initial-roster", failed: false });
      expect(current?.nativeResolvedAt).not.toBeNull();
      owner.events.emit("load");
      const observed = (await owner.capture()).value.lifecycle;
      expect(observed.navigation).toEqual(current);
      expect(observed.lastLoadObservedAt).not.toBeNull();
      owner.close();
      expect(owner.events.listenerCount("load")).toBe(0);
      expect(owner.events.listenerCount("domcontentloaded")).toBe(0);
    },
  );
});
