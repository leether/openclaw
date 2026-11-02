import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSkillLibraryNodeAdmissionFailure,
  reportSkillLibraryNodeAdmissionFailure,
  SkillLibraryWireError,
} from "../e2e/qa-lab/runtime/skill-library-node-admission-diagnostics.js";
import { prepareSkillLibraryNodeProcess } from "../e2e/qa-lab/runtime/skill-library-node-process.js";
import { SkillLibraryWireClient } from "../e2e/qa-lab/runtime/skill-library-wire-fixture.js";

type Request = { id: string; method: string };
type Transport = {
  sent: Request[];
  onSend?: (request: Request) => void;
  reply: (frame: unknown) => void;
};
const fixture = vi.hoisted(() => {
  const transport: { current?: Transport } = {};
  return { transport, cleanup: vi.fn<() => Promise<void>>(), childClosed: false };
});

// Exercise the real pending map and receive handler without opening a socket or booting a Gateway.
vi.mock("../../packages/gateway-client/src/websocket.test-support.js", async () => {
  const { EventEmitter } = await import("node:events");
  class WebSocket extends EventEmitter {
    static CLOSED = 3;
    readyState = 1;
    sent: Request[] = [];
    onSend?: (request: Request) => void;
    constructor() {
      super();
      fixture.transport.current = this;
      queueMicrotask(() => this.reply({ type: "event", event: "connect.challenge" }));
    }
    reply(frame: unknown) {
      this.emit("message", Buffer.from(JSON.stringify(frame)));
    }
    send(data: string) {
      const frame: unknown = JSON.parse(data);
      if (
        typeof frame !== "object" ||
        frame === null ||
        !("id" in frame) ||
        typeof frame.id !== "string" ||
        !("method" in frame) ||
        typeof frame.method !== "string"
      ) {
        throw new Error("Invalid synthetic request");
      }
      const request = { id: frame.id, method: frame.method };
      this.sent.push(request);
      if (request.method === "connect") {
        queueMicrotask(() => this.reply({ type: "res", id: request.id, ok: true, payload: {} }));
      } else {
        this.onSend?.(request);
      }
    }
    close() {
      this.readyState = WebSocket.CLOSED;
      this.emit("close", 1000);
    }
    terminate() {
      this.close();
    }
  }
  return { WebSocket };
});
vi.mock(
  "../../packages/gateway-protocol/src/index.js",
  async () => import("../../packages/gateway-protocol/src/version.js"),
);
vi.mock("../../src/version.js", () => ({ VERSION: "synthetic" }));
vi.mock("node:fs/promises", () => ({ default: { mkdir: vi.fn(async () => undefined) } }));
vi.mock("../../src/infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: () => ({ deviceId: "synthetic-node" }),
}));
vi.mock("../helpers/openclaw-test-instance.js", () => ({
  createOpenClawTestInstance: async () => ({
    stateDir: "/synthetic-proof-state",
    env: {},
    state: { writeConfig: async () => undefined },
    entrypoint: async () => ["synthetic-node-entry"],
    cleanup: fixture.cleanup,
  }),
}));
vi.mock("../../scripts/lib/managed-child-process.mts", () => ({
  runManagedCommand: ({ signal }: { signal: AbortSignal }) =>
    new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          fixture.childClosed = true;
          reject(Object.assign(new Error("Synthetic child cancelled"), { code: "ABORT_ERR" }));
        },
        { once: true },
      );
    }),
}));

let client: SkillLibraryWireClient | undefined;
beforeEach(() => {
  fixture.cleanup.mockReset().mockResolvedValue(undefined);
  fixture.childClosed = false;
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  fixture.transport.current = undefined;
});

async function connect() {
  ({ client } = await SkillLibraryWireClient.connect({
    port: 1,
    url: "ws://synthetic.invalid",
    gatewayToken: "synthetic-password",
  }));
  if (!fixture.transport.current) {
    throw new Error("Synthetic socket was not constructed");
  }
  return { admin: client, transport: fixture.transport.current };
}
const missingScope = {
  code: "INVALID_REQUEST",
  message: "private message must not escape",
  retryable: false,
  details: {
    code: "MISSING_SCOPE",
    missingScope: "operator.pairing",
    requiredScopes: ["operator.pairing"],
    token: "synthetic-private-token",
  },
};

it("joins out-of-order concurrent errors to the pending method and ignores unmatched or repeated IDs", async () => {
  const { admin, transport } = await connect();
  const caught: unknown[] = [];
  const first = admin.request("node.list", { nodeId: "private-node" }).catch((error: unknown) => {
    caught.push(error);
    return error;
  });
  const second = admin
    .request("node.pair.approve", { requestId: "private-request" })
    .catch((error: unknown) => {
      caught.push(error);
      return error;
    });
  const requests = transport.sent.slice(1);
  expect(requests).toHaveLength(2);
  const [firstRequest, secondRequest] = requests;
  if (!firstRequest || !secondRequest) {
    throw new Error("Expected both concurrent requests");
  }
  transport.reply({ type: "res", id: "unmatched-id", ok: false, error: missingScope });
  expect(caught).toEqual([]);
  transport.reply({
    type: "res",
    id: secondRequest.id,
    ok: false,
    method: "node.list",
    error: missingScope,
  });
  const secondError = await second;
  expect(secondError).toBeInstanceOf(SkillLibraryWireError);
  expect(readSkillLibraryNodeAdmissionFailure(secondError, "command-approval")).toEqual({
    stage: "command-approval",
    method: "node.pair.approve",
    outcome: "rpc-error",
    code: "INVALID_REQUEST",
    category: "missing-scope",
    retryable: false,
    missingScope: "operator.pairing",
  });
  transport.reply({ type: "res", id: secondRequest.id, ok: false, error: missingScope });
  transport.reply({
    type: "res",
    id: firstRequest.id,
    ok: false,
    error: { code: "INVALID_REQUEST", message: "unknown requestId" },
  });
  expect(readSkillLibraryNodeAdmissionFailure(await first, "device-admission")).toMatchObject({
    method: "node.list",
    category: "unknown-request-id",
  });
  expect(caught).toHaveLength(2);
  expect(
    JSON.stringify(
      caught.map((error) => readSkillLibraryNodeAdmissionFailure(error, "command-approval")),
    ),
  ).not.toMatch(/private|token|requestId|nodeId/u);
});

it("retains success and error-without-payload behavior without inventing an RPC diagnostic", async () => {
  const { admin, transport } = await connect();
  transport.onSend = ({ id, method }) =>
    transport.reply(
      method === "node.list"
        ? { type: "res", id, ok: true, payload: { nodes: [] } }
        : { type: "res", id, ok: false },
    );
  await expect(admin.request("node.list", {})).resolves.toEqual({ nodes: [] });
  const error: unknown = await admin
    .request("node.pair.list", {})
    .catch((failure: unknown) => failure);
  expect(error).toEqual(new Error("RPC failed without an error"));
  expect(readSkillLibraryNodeAdmissionFailure(error, "command-approval")).toBeNull();
});

it("normalizes malicious response field types without publishing the supplied strings", async () => {
  const { admin, transport } = await connect();
  transport.onSend = ({ id }) =>
    transport.reply({
      type: "res",
      id,
      ok: false,
      error: {
        code: "private-code",
        message: "private-message",
        retryable: "private-flag",
        details: { missingScope: "private-scope", token: "private-token" },
      },
    });
  const error: unknown = await admin
    .request("private-method", {})
    .catch((failure: unknown) => failure);
  expect(readSkillLibraryNodeAdmissionFailure(error, "device-admission")).toEqual({
    stage: "device-admission",
    method: "other",
    outcome: "rpc-error",
    code: "other",
    category: "other",
    retryable: null,
    missingScope: null,
  });
});

describe("private protocol classification", () => {
  it.each([
    [
      {
        code: "UNAVAILABLE",
        message: "hidden",
        retryable: true,
        details: { reason: "startup-sidecars" },
      },
      "startup-unavailable",
    ],
    [
      {
        code: "UNAVAILABLE",
        message: "hidden",
        details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
      },
      "authenticated-profile-unavailable",
    ],
    [{ code: "INVALID_REQUEST", message: "unknown requestId extra private" }, "other"],
    [{ code: "FORBIDDEN", message: "missing scope: operator.pairing" }, "other"],
  ] as const)(
    "projects only recognized structured or exact fixed errors: %s",
    (error, category) => {
      expect(
        readSkillLibraryNodeAdmissionFailure(
          new SkillLibraryWireError(error, "node.list"),
          "device-admission",
        ),
      ).toMatchObject({ category });
    },
  );

  it("maps arbitrary method, code and scope to other/null and never parses private prose", () => {
    const error = new SkillLibraryWireError(
      {
        ...missingScope,
        code: "FORBIDDEN",
        details: { ...missingScope.details, missingScope: "private-scope" },
      },
      "private-method",
    );
    expect(readSkillLibraryNodeAdmissionFailure(error, "worker-inventory")).toMatchObject({
      method: "other",
      category: "missing-scope",
      missingScope: null,
    });
    const unknown = new SkillLibraryWireError(
      { code: "private-code", message: "private-message" },
      "private-method",
    );
    expect(readSkillLibraryNodeAdmissionFailure(unknown, "worker-inventory")).toEqual({
      stage: "worker-inventory",
      method: "other",
      outcome: "rpc-error",
      code: "other",
      category: "other",
      retryable: null,
      missingScope: null,
    });
  });

  it("has no default output and never reports ordinary timeout or socket errors", () => {
    const report = vi.fn();
    reportSkillLibraryNodeAdmissionFailure(
      new Error("node.list timed out"),
      "device-admission",
      report,
    );
    reportSkillLibraryNodeAdmissionFailure(
      new Error("Gateway socket closed (1006)"),
      "device-admission",
      report,
    );
    reportSkillLibraryNodeAdmissionFailure(
      new SkillLibraryWireError(missingScope, "node.list"),
      "device-admission",
    );
    expect(report).not.toHaveBeenCalled();
  });
});

it.each(["device-admission", "command-approval", "worker-inventory"] as const)(
  "reports %s once without letting a throwing diagnostic callback replace the original error or cleanup",
  async (stage) => {
    const { admin, transport } = await connect();
    let listCalls = 0;
    transport.onSend = ({ id, method }) => {
      if (method === "node.list") {
        listCalls += 1;
      }
      const fail =
        stage === "device-admission" ||
        (stage === "command-approval" && method === "node.pair.approve") ||
        (stage === "worker-inventory" && listCalls === 3);
      const payload =
        method === "node.pair.list"
          ? { pending: [{ requestId: "synthetic-pair", nodeId: "synthetic-node" }] }
          : {
              nodes: [
                {
                  nodeId: "synthetic-node",
                  ...(stage === "worker-inventory" && listCalls === 2
                    ? { approvalState: "approved" }
                    : {}),
                },
              ],
            };
      transport.reply(
        fail
          ? { type: "res", id, ok: false, error: missingScope }
          : { type: "res", id, ok: true, payload },
      );
    };
    const node = await prepareSkillLibraryNodeProcess({
      port: 1,
      gatewayToken: "synthetic-password",
    });
    const onAdmissionFailure = vi.fn(() => {
      throw new Error("diagnostic callback failed");
    });
    const error: unknown = await node
      .start(admin, { onAdmissionFailure })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SkillLibraryWireError);
    expect(error).toMatchObject({ error: missingScope, message: missingScope.message });
    expect(onAdmissionFailure).toHaveBeenCalledExactlyOnceWith({
      stage,
      method: stage === "command-approval" ? "node.pair.approve" : "node.list",
      outcome: "rpc-error",
      code: "INVALID_REQUEST",
      category: "missing-scope",
      retryable: false,
      missingScope: "operator.pairing",
    });
    expect(fixture.childClosed).toBe(true);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    await node.stop();
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  },
);

it("preserves the original RPC error alongside cleanup failure", async () => {
  const { admin, transport } = await connect();
  transport.onSend = ({ id }) =>
    transport.reply({ type: "res", id, ok: false, error: missingScope });
  const cleanupFailure = new Error("synthetic cleanup failure");
  fixture.cleanup.mockRejectedValueOnce(cleanupFailure);
  const node = await prepareSkillLibraryNodeProcess({
    port: 1,
    gatewayToken: "synthetic-password",
  });
  const report = vi.fn();
  const error: unknown = await node
    .start(admin, { onAdmissionFailure: report })
    .catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) {
    throw new Error("Expected the original aggregate cleanup contract");
  }
  expect(error.errors).toHaveLength(2);
  expect(error.errors[0]).toBeInstanceOf(SkillLibraryWireError);
  expect(error.errors[1]).toBe(cleanupFailure);
  expect(error.cause).toBe(cleanupFailure);
  expect(report).toHaveBeenCalledOnce();
  expect(fixture.childClosed).toBe(true);
});
