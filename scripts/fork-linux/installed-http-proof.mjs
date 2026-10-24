// Installed-package qualification. Run only inside an external-network-denied
// namespace/container; no production files or credentials are required.
// Usage: node installed-timer-proof.mjs <package-root> <node-binary> <new-state-dir>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { assertReadyInstall, qualifyMetadataCli } from "./installed-cli-proof.mjs";
import { fixtureSourceCallId, planInstalledModelResponse } from "./installed-model-fixture.mjs";
const [packageRoot, runtime, root] = process.argv.slice(2).map((p) => path.resolve(p));
assert.ok(packageRoot && runtime && root, "three absolute paths required");
assert.equal(process.env.QUALIFICATION_NETWORK_ISOLATED, "1", "caller must deny external network");
await fs.mkdir(root); // Exclusive synthetic root: existing state must never be overwritten.
await fs.mkdir(path.join(root, "state"));
await fs.mkdir(path.join(root, "workspace"));
const cli = path.join(packageRoot, "openclaw.mjs");
const token = "synthetic-installed-timer-proof";
const report = {
  schemaVersion: 1,
  node: process.version,
  syntheticOnly: true,
  startedAt: new Date().toISOString(),
  assertions: [],
  modelProtocol: [],
  passed: false,
};
const children = new Set();
const metadataHolds = new Map();
let gateway,
  gatewayLog = "",
  toolResponse,
  toolRelease,
  toolStartResolve,
  toolCalls = 0,
  modelCalls = 0;
const toolStarted = new Promise((resolve) => {
  toolStartResolve = resolve;
});
let failMock;
const mockFailure = new Promise((_, reject) => {
  failMock = reject;
});
void mockFailure.catch(() => {});
const bounded = async (promise, ms, name, observeMock = true) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      ...(observeMock ? [mockFailure] : []),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(name + " wall deadline")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
function own(args) {
  const child = spawn(runtime, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.on("close", () => children.delete(child));
  return child;
}
async function command(args, signal) {
  signal?.throwIfAborted();
  const child = own(args);
  let stdout = "",
    stderr = "",
    stopped = false;
  const stop = () => {
    stopped = true;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(stop, 25000);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) {
    stop();
  }
  child.stdout.on("data", (b) => {
    stdout += b;
    if (stdout.length > 2 * 1024 * 1024) {
      stop();
    }
  });
  child.stderr.on("data", (b) => {
    stderr += b;
    if (stderr.length > 2 * 1024 * 1024) {
      stop();
    }
  });
  const [code] = await once(child, "close");
  clearTimeout(timer);
  signal?.removeEventListener("abort", stop);
  assert.equal(stopped, false, "CLI limit");
  assert.equal(code, 0, stderr.slice(-3000));
  return stdout;
}
async function handleMock(req, res) {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/metadata-hold" || url.pathname === "/metadata-settled") {
      const hold = metadataHolds.get(url.searchParams.get("nonce"));
      assert.ok(hold, "known synthetic metadata request");
      if (url.pathname === "/metadata-hold") {
        hold.release = () => res.end("released");
        hold.admit();
      } else {
        res.end("settled");
        hold.settle();
      }
      return;
    }
    if (url.pathname === "/tool") {
      assert.equal(url.searchParams.get("callId"), fixtureSourceCallId);
      toolCalls++;
      assert.equal(toolCalls, 1);
      report.sourceToolCallId = fixtureSourceCallId;
      toolResponse = res;
      toolRelease = () => res.end("synthetic tool completed");
      toolStartResolve();
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end("{}");
      return;
    }
    let raw = "";
    for await (const b of req) {
      raw += b;
      assert.ok(raw.length <= 1024 * 1024);
    }
    const input = JSON.parse(raw);
    modelCalls++;
    const { message, reason, action } = planInstalledModelResponse(input);
    assert.ok(report.modelProtocol.length < 8, "bounded synthetic model rounds");
    report.modelProtocol.push({ action });
    if (input.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta =
        reason === "tool_calls"
          ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls[0] }] }
          : message;
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: reason },
      ]) {
        res.write(
          "data: " +
            JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "mock",
              choices: [choice],
            }) +
            "\n\n",
        );
      }
      res.end("data: [DONE]\n\n");
    } else {
      res.end(
        JSON.stringify({
          id: "fixture",
          object: "chat.completion",
          created: 1,
          model: "mock",
          choices: [{ index: 0, message, finish_reason: reason }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
      );
    }
  } catch (error) {
    failMock(error);
    res.writeHead(500).end(JSON.stringify({ error: String(error) }));
  }
}
const mock = http.createServer((req, res) => {
  void handleMock(req, res).catch((/** @type {unknown} */ error) => {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});
mock.listen(0, "127.0.0.1");
await once(mock, "listening");
const provider = `http://127.0.0.1:${mock.address().port}`;
const pluginDir = path.join(root, "timer-fixture-plugin");
await fs.mkdir(pluginDir);
await fs.writeFile(
  path.join(pluginDir, "package.json"),
  JSON.stringify({
    name: "timer-fixture",
    version: "0.0.0",
    type: "module",
    openclaw: { extensions: ["./index.mjs"] },
  }),
);
await fs.writeFile(
  path.join(pluginDir, "openclaw.plugin.json"),
  JSON.stringify({
    id: "timer-fixture",
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false },
    contracts: { tools: ["timer_fixture_tool"] },
  }),
);
await fs.writeFile(
  path.join(pluginDir, "index.mjs"),
  `export default function(api) {
    api.registerTool({ name:'timer_fixture_tool', description:'Synthetic qualification tool', parameters:{type:'object',properties:{},additionalProperties:false}, async execute(callId) { const r=await fetch(${JSON.stringify(provider + "/tool?callId=")}+encodeURIComponent(callId)); const text=await r.text(); return {content:[{type:'text',text}],details:{status:'completed',fixture:'timer-source-v1'}}; } });
    api.registerGatewayMethod('timer-fixture.metadataHold', async ({params,respond}) => {
      const nonce=encodeURIComponent(params.nonce);
      const held=await fetch(${JSON.stringify(provider + "/metadata-hold?nonce=")}+nonce);
      await held.text();
      respond(true,{ok:true,nonce:params.nonce});
      const settled=await fetch(${JSON.stringify(provider + "/metadata-settled?nonce=")}+nonce);
      await settled.text();
    }, {scope:'operator.read',profileAccess:'independent'});
  }`,
);
const config = {
  gateway: {
    mode: "local",
    bind: "loopback",
    port: 18789,
    auth: { mode: "token", token },
    http: { endpoints: { responses: { enabled: true } } },
  },
  agents: {
    defaults: {
      workspace: path.join(root, "workspace"),
      model: { primary: "fixture/mock" },
      heartbeat: { every: "0m" },
      skipBootstrap: true,
    },
    entries: { main: { workspace: path.join(root, "workspace") } },
  },
  models: {
    mode: "replace",
    providers: {
      fixture: {
        baseUrl: provider + "/v1",
        apiKey: "synthetic-only",
        api: "openai-completions",
        models: [
          {
            id: "mock",
            name: "Fixture",
            contextWindow: 131072,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
  memory: { search: { enabled: false } },
  channels: {},
  cron: { enabled: false },
  plugins: {
    enabled: true,
    allow: ["timer-fixture"],
    load: { paths: [pluginDir] },
    slots: { memory: "none" },
    entries: { "timer-fixture": { enabled: true } },
  },
  tools: { allow: ["timer_fixture_tool"] },
  logging: { file: path.join(root, "gateway.log"), maxFileBytes: 8 * 1024 * 1024 },
};
await fs.writeFile(path.join(root, "state", "openclaw.json"), JSON.stringify(config));
const env = {
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
  OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
  OPENCLAW_GATEWAY_TOKEN: token,
  OPENCLAW_NO_RESPAWN: "1",
  OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED: "1",
  OPENCLAW_NODE_UPDATE_RESPAWNED: "1",
  OPENCLAW_CLI_CONTAINER_BYPASS: "1",
  OPENCLAW_NO_AUTO_UPDATE: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
  NODE_DISABLE_COMPILE_CACHE: "1",
  NO_COLOR: "1",
  SHELL: "/bin/sh",
  TMPDIR: "/tmp",
  PATH: path.dirname(runtime) + ":/usr/bin:/bin",
};
async function status(signal) {
  const value = JSON.parse(
    await command(
      [
        "--no-color",
        "gateway",
        "call",
        "status",
        "--timeout",
        "15000",
        "--params",
        '{"includeChannelSummary":false}',
        "--json",
      ],
      signal,
    ),
  );
  assert.equal(value.timerBudget?.protocol, "timer-budget-v1");
  assert.equal(value.executionDrain?.protocol, "tool-drain-v1");
  assert.equal(value.executionDrain.ownerEpoch, value.timerBudget.ownerEpoch);
  assert.ok(Number.isFinite(Date.parse(value.executionDrain.sampledAt)));
  const names = [
    "actualToolExecutions",
    "timerRequests",
    "queueSize",
    "pendingReplies",
    "embeddedRuns",
    "backgroundExecSessions",
    "cronRuns",
    "agentRuns",
    "acpRuns",
    "mediaRuns",
    "rootRequests",
    "sessionAdmissions",
    "sessionMutations",
    "chatRuns",
    "queuedTurns",
    "terminalPersistence",
    "terminalSessions",
    "lifecycleWrites",
    "totalActive",
  ];
  for (const name of names) {
    assert.ok(
      Number.isInteger(value.executionDrain.counts[name]) && value.executionDrain.counts[name] >= 0,
      name,
    );
  }
  return value;
}
function post(input, budget, signal = AbortSignal.timeout(30000), auth = true) {
  return fetch("http://127.0.0.1:18789/v1/responses", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...(budget ? { "x-openclaw-timer-budget": JSON.stringify(budget) } : {}),
    },
    body: JSON.stringify({ model: "openclaw", input }),
  });
}
const hardTimer = setTimeout(() => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  mock.closeAllConnections();
}, 240000);
try {
  report.installMarkers = await assertReadyInstall(packageRoot);
  report.cliVersion = (await command(["--version"])).trim();
  gateway = own(["gateway", "run"]);
  for (const stream of [gateway.stdout, gateway.stderr]) {
    stream.on("data", (b) => {
      gatewayLog += b;
      if (gatewayLog.length > 8 * 1024 * 1024) {
        gateway.kill("SIGKILL");
      }
    });
  }
  await bounded(
    (async () => {
      for (;;) {
        if (gateway.exitCode !== null || gateway.signalCode !== null) {
          throw new Error("Gateway exited: " + gatewayLog.slice(-3000));
        }
        try {
          if (
            (await fetch("http://127.0.0.1:18789/readyz", { signal: AbortSignal.timeout(500) })).ok
          ) {
            return;
          }
        } catch {}
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      }
    })(),
    80000,
    "startup",
  );
  report.metadataCli = await qualifyMetadataCli({ own, metadataHolds });
  const before = await status();
  report.ownerEpoch = before.timerBudget.ownerEpoch;
  const budget = (remainingMs) => ({
    version: "timer-budget-v1",
    remainingMs,
    answerReserveMs: 120000,
    maxSearchCalls: 4,
    searchCallTimeoutMs: 45000,
    expectedOwnerEpoch: report.ownerEpoch,
  });
  const unauth = await post("synthetic", budget(480000), undefined, false);
  assert.equal(unauth.status, 401);
  await unauth.text();
  report.assertions.push("unauthenticated-rejected");
  const stale = await post("synthetic", { ...budget(480000), expectedOwnerEpoch: "stale-owner" });
  assert.equal(stale.status, 400);
  await stale.text();
  report.assertions.push("stale-owner-rejected");
  for (const ms of [480000, 240000]) {
    const response = await post("SYNTHETIC_SIMPLE_ANSWER", budget(ms));
    const body = await response.text();
    assert.equal(response.status, 200, body.slice(0, 500));
    assert.equal(response.headers.get("x-openclaw-timer-budget"), "timer-budget-v1");
    assert.match(body, /SYNTHETIC_TIMER_OK/);
    report.assertions.push(`installed-http-ack-answer-${ms}`);
  }
  const controller = new AbortController();
  const pending = post("PROVE_ACTUAL_TOOL", budget(480000), controller.signal)
    .then((r) => r.text())
    .then(
      () => ({ returned: true }),
      (/** @type {unknown} */ error) => ({
        aborted: controller.signal.aborted,
        error: error instanceof Error ? error.name : String(error),
      }),
    );
  await bounded(
    Promise.race([
      toolStarted,
      pending.then(() => {
        throw new Error("HTTP settled before the actual tool was admitted");
      }),
    ]),
    30000,
    "tool admission",
  );
  const active = await status();
  // The advertised dispatcher and its one hidden source each own a promise.
  assert.equal(active.executionDrain.counts.actualToolExecutions, 2);
  assert.equal(toolCalls, 1);
  assert.equal(active.executionDrain.idle, false);
  const cancellationStarted = performance.now();
  const cancellationSignal = AbortSignal.timeout(5000);
  controller.abort();
  await bounded(
    (async () => {
      const cancelled = await pending;
      assert.equal(cancelled.aborted, true);
      for (;;) {
        cancellationSignal.throwIfAborted();
        const { executionDrain } = await status(cancellationSignal);
        if (
          executionDrain.counts.timerRequests === 0 &&
          executionDrain.counts.actualToolExecutions === 1 &&
          !executionDrain.idle
        ) {
          assert.equal(toolResponse.writableEnded, false);
          assert.equal(toolResponse.destroyed, false);
          assert.ok(toolResponse.socket && !toolResponse.socket.destroyed);
          const elapsedMs = performance.now() - cancellationStarted;
          assert.ok(elapsedMs < 5000, "client and server cancellation share five seconds");
          report.cancellationProof = {
            clientAborted: true,
            elapsedMs,
            timerRequests: 0,
            actualToolExecutions: 1,
            idle: false,
            sourceResponseOpen: true,
            sourceSocketOpen: true,
          };
          return;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
    })(),
    5000,
    "HTTP and server cancellation",
  );
  report.toolExecutionCounts = { admitted: 2, afterCancellation: 1 };
  report.assertions.push("cancelled-http-retains-actual-tool-drain");
  toolRelease();
  await bounded(
    (async () => {
      for (;;) {
        const value = await status();
        if (value.executionDrain.idle) {
          assert.equal(value.executionDrain.counts.actualToolExecutions, 0);
          assert.equal(value.executionDrain.counts.timerRequests, 0);
          report.finalDrain = value.executionDrain;
          report.toolExecutionCounts.settled = 0;
          return;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      }
    })(),
    35000,
    "tool settlement drain",
  );
  report.assertions.push("actual-tool-settlement-releases-drain");
  assert.equal(toolCalls, 1, "one actual source execution, without retry");
  assert.deepEqual(report.modelProtocol, [
    { action: "answer" },
    { action: "answer" },
    { action: "call" },
  ]);
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  toolRelease?.();
  for (const child of children) {
    const closed = once(child, "close");
    child.kill("SIGTERM");
    await bounded(closed, 10000, "shutdown", false).catch(async () => {
      child.kill("SIGKILL");
      await bounded(closed, 5000, "kill cleanup", false);
    });
  }
  clearTimeout(hardTimer);
  mock.closeAllConnections();
  await new Promise((resolve) => {
    mock.close(resolve);
  });
  report.modelCalls = modelCalls;
  report.toolCalls = toolCalls;
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, "process.log"), gatewayLog);
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
