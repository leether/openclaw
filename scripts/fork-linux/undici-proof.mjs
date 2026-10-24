// Real installed Undici HTTP/1, proxy, cancellation, and queue qualification.
// All peers are synthetic loopback servers; the caller also owns an offline namespace.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function bounded(promise, ms = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Synthetic HTTP phase exceeded its budget")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function qualifyUndici(packageRoot) {
  const root = fs.realpathSync(packageRoot);
  const require = createRequire(path.join(root, "package.json"));
  const manifestPath = fs.realpathSync(require.resolve("undici/package.json"));
  const relative = path.relative(root, manifestPath);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.name, "undici");
  assert.equal(manifest.version, "8.12.2");
  const { request, Pool, ProxyAgent, EnvHttpProxyAgent } = require("undici");
  const sockets = new Set();
  const dispatchers = [];
  const pendingWork = [];
  const observe = (promise) => {
    pendingWork.push(promise);
    promise.catch(() => {});
    return promise;
  };
  const admissions = new Map();
  const received = [];
  const tunnels = [];
  const tracked = (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const serverErrors = [];
  const handleTarget = async (req, res) => {
    received.push(req.url);
    const hold = admissions.get(req.url);
    if (hold) {
      const closed = deferred();
      req.socket.once("close", closed.resolve);
      hold.resolve({ req, res, closed: closed.promise });
      if (req.url === "/body") {
        res.writeHead(200);
        res.write("partial");
      }
      return;
    }
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(
      JSON.stringify({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString() }),
    );
  };
  const target = http.createServer((req, res) => {
    observe(handleTarget(req, res)).catch((error) => {
      serverErrors.push(error);
      res.destroy(error);
    });
  });
  target.on("connection", tracked);
  let targetAuthority;
  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url);
    if (url.protocol !== "http:" || url.host !== targetAuthority) {
      res.writeHead(502);
      res.end();
      return;
    }
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: target.address().port,
        path: `${url.pathname}${url.search}`,
        method: req.method,
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("socket", tracked);
    upstream.on("error", () => res.destroy());
    req.once("aborted", () => upstream.destroy());
    res.once("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.on("connection", tracked);
  proxy.on("connect", (req, socket, head) => {
    if (req.url !== targetAuthority) {
      socket.destroy();
      return;
    }
    tunnels.push(req.url);
    const upstream = tracked(net.connect({ host: "127.0.0.1", port: target.address().port }));
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) {
        upstream.write(head);
      }
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
  });
  let passed = false;
  const started = performance.now();
  const cases = [];
  let phase = "listen";
  async function listen(server) {
    await bounded(
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      }),
    );
  }
  try {
    await listen(target);
    await listen(proxy);
    targetAuthority = `127.0.0.1:${target.address().port}`;
    const origin = `http://${targetAuthority}`;
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    const pool = new Pool(origin, { connections: 1, pipelining: 1, allowH2: false });
    dispatchers.push(pool);
    phase = "direct-http1-body";
    const direct = await bounded(
      pool.request({ path: "/echo", method: "POST", body: "synthetic" }),
    );
    assert.equal(direct.statusCode, 200);
    assert.equal(direct.headers["content-type"], "application/json");
    assert.equal(direct.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(await bounded(direct.body.json()), {
      path: "/echo",
      method: "POST",
      body: "synthetic",
    });
    cases.push("direct-http1-body");

    phase = "queued-cancel-no-admission";
    const held = deferred();
    admissions.set("/hold", held);
    const first = observe(pool.request({ path: "/hold", method: "GET" }));
    const admitted = await bounded(held.promise);
    const cancelQueue = new AbortController();
    const queued = observe(
      pool.request({ path: "/queued", method: "GET", signal: cancelQueue.signal }),
    );
    const queuedRejected = observe(assert.rejects(queued, (error) => error.name === "AbortError"));
    cancelQueue.abort();
    assert.equal(received.includes("/queued"), false);
    // Undici records a queued abort and rejects when that queue position is
    // processed. The active request must settle first; no wire admission follows.
    admitted.res.end("released");
    assert.equal(await bounded((await bounded(first)).body.text()), "released");
    await bounded(queuedRejected);
    cases.push("queued-cancel-no-admission");

    async function cancelRequest(name, dispatcher, body) {
      phase = name;
      const admission = deferred();
      admissions.set(name, admission);
      const signal = new AbortController();
      const pending = observe(request(`${origin}${name}`, { dispatcher, signal: signal.signal }));
      const rejected = body
        ? null
        : observe(assert.rejects(pending, (error) => error.name === "AbortError"));
      const peer = await bounded(admission.promise);
      const response = body ? await bounded(pending) : null;
      const bodyRejected = body
        ? observe(assert.rejects(response.body.text(), (error) => error.name === "AbortError"))
        : null;
      signal.abort();
      await bounded(rejected ?? bodyRejected);
      await bounded(peer.closed);
      assert.equal(peer.req.socket.destroyed, true);
      cases.push(
        body
          ? "body-cancel-peer-closed"
          : name === "/forward-cancel"
            ? "forward-proxy-cancel-peer-closed"
            : name === "/proxy-cancel"
              ? "proxy-cancel-peer-closed"
              : "headers-cancel-peer-closed",
      );
    }
    await cancelRequest("/headers", pool, false);
    await cancelRequest("/body", pool, true);
    phase = "explicit-connect-proxy";
    // HTTP proxies use forwarding by default. This fixture owns a CONNECT
    // endpoint, so request the documented tunneling mode explicitly.
    const explicit = new ProxyAgent({ uri: proxyUrl, proxyTunnel: true, allowH2: false });
    dispatchers.push(explicit);
    const viaProxy = await bounded(request(`${origin}/proxy`, { dispatcher: explicit }));
    assert.equal(viaProxy.statusCode, 200);
    assert.equal((await bounded(viaProxy.body.json())).path, "/proxy");
    assert.equal(tunnels.length, 1);
    cases.push("explicit-connect-proxy");
    await cancelRequest("/proxy-cancel", explicit, false);
    phase = "environment-connect-proxy";
    const environment = new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy: "",
      proxyTunnel: true,
      allowH2: false,
    });
    dispatchers.push(environment);
    const beforeEnv = tunnels.length;
    const viaEnv = await bounded(request(`${origin}/env`, { dispatcher: environment }));
    assert.equal(viaEnv.statusCode, 200);
    assert.equal((await bounded(viaEnv.body.json())).path, "/env");
    assert.equal(tunnels.length, beforeEnv + 1);
    cases.push("environment-connect-proxy");
    // Vertex and Slack use EnvHttpProxyAgent without forcing a tunnel. Keep
    // that real HTTP-forwarding contract separate from the CONNECT callers.
    phase = "environment-forward-proxy";
    const forwarding = new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy: "",
      allowH2: false,
    });
    dispatchers.push(forwarding);
    const beforeForward = tunnels.length;
    const viaForward = await bounded(request(`${origin}/forward`, { dispatcher: forwarding }));
    assert.equal(viaForward.statusCode, 200);
    assert.equal((await bounded(viaForward.body.json())).path, "/forward");
    assert.equal(tunnels.length, beforeForward);
    cases.push("environment-forward-proxy");
    await cancelRequest("/forward-cancel", forwarding, false);
    assert.equal(tunnels.length, beforeForward);
    assert.equal(received.filter((value) => value === "/queued").length, 0);
    assert.equal(received.length, 9);
    passed = true;
  } catch (error) {
    throw new Error(`${phase}: ${error.message}; completed=${cases.join(",")}`, { cause: error });
  } finally {
    try {
      await bounded(Promise.all(dispatchers.map((dispatcher) => dispatcher.destroy())), 3000);
    } finally {
      const closed = [...sockets].map(
        (socket) =>
          new Promise((resolve) => {
            socket.once("close", resolve);
            socket.destroy();
          }),
      );
      await bounded(
        Promise.all([
          ...closed,
          ...[target, proxy].map(
            (server) =>
              new Promise((resolve, reject) => {
                if (!server.listening) {
                  resolve();
                  return;
                }
                server.close((error) => (error ? reject(error) : resolve()));
              }),
          ),
        ]),
        3000,
      );
      await bounded(Promise.allSettled(pendingWork), 3000);
    }
  }
  assert.equal(
    serverErrors.length,
    0,
    "synthetic HTTP request handler must complete without errors",
  );
  assert.equal(sockets.size, 0);
  assert.equal(target.listening, false);
  assert.equal(proxy.listening, false);
  return {
    schema: "installed-undici-proof-v1",
    passed,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    identity: {
      name: manifest.name,
      version: manifest.version,
      packageRelative: relative.split(path.sep).join("/"),
      packageSha256: sha(manifestBytes),
    },
    caseCounts: { passed: cases.length, receivedRequests: received.length, queuedAdmitted: 0 },
    cases,
    cleanup: { sockets: sockets.size, serversClosed: true, dispatchersDestroyed: true },
    elapsedMs: Math.round(performance.now() - started),
    limits: { perPhaseMs: 2000, cleanupPhaseMs: 3000, loopbackOnly: true },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  assert.ok(path.isAbsolute(root) && path.isAbsolute(output));
  let report;
  try {
    report = await qualifyUndici(root);
  } catch (error) {
    report = {
      schema: "installed-undici-proof-v1",
      passed: false,
      error: String(error.message).slice(0, 2000),
    };
  }
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ passed: report.passed, cases: report.caseCounts }));
  if (!report.passed) {
    process.exitCode = 1;
  }
}
