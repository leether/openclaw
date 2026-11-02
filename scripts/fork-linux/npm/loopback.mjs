import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { gzipSync } from "node:zlib";

export const TARGET = "24.22.1";
export const HEADER_FILES = {
  "include/node/fixture.h": "/* synthetic header: not an ABI build */\n",
  "include/node/fixture.gypi": "{}\n",
};

export function syntheticHeaders() {
  const chunks = [];
  for (const [file, content] of Object.entries(HEADER_FILES)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`node-v${TARGET}/${file}`);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  const data = gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
  assert.ok(data.length < 32768);
  return data;
}

export function proxyTargetAllowed(authority, expectedPort) {
  return authority === `127.0.0.1:${expectedPort}`;
}

// Both ends of each CONNECT tunnel are tracked; only a single nonce-bound
// loopback origin is reachable. Unknown paths/targets fail instead of forwarding.
export async function startFixture({ mode = "normal", onHeld = () => {} } = {}) {
  const nonce = randomUUID();
  const tar = syntheticHeaders();
  const tarHash = createHash("sha256").update(tar).digest("hex");
  const prefix = `/${nonce}/v${TARGET}/`;
  const filename = `node-v${TARGET}-headers.tar.gz`;
  const sockets = new Set();
  const empty = new EventEmitter();
  const requests = [];
  let connections = 0;
  let proxyConnects = 0;
  let sentBytes = 0;
  let unexpected = null;
  const track = (socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      if (!sockets.size) {
        empty.emit("empty");
      }
    });
    if (connections > 32) {
      unexpected = "connection-limit";
      socket.destroy();
    }
    return socket;
  };
  const origin = http.createServer((request, response) => {
    if (
      requests.length >= 16 ||
      request.method !== "GET" ||
      ![prefix + filename, prefix + "SHASUMS256.txt"].includes(request.url)
    ) {
      unexpected = "unexpected-request";
      response.writeHead(400).end();
      return;
    }
    if (!/^node-gyp v13\.0\.0 \(node v[0-9.]+\)$/.test(request.headers["user-agent"] ?? "")) {
      unexpected = "unexpected-consumer";
      response.writeHead(400).end();
      return;
    }
    requests.push({ path: request.url.slice(prefix.length), method: request.method });
    if (request.url.endsWith(filename) && mode === "hold-before-headers") {
      onHeld();
      return;
    }
    const sum = mode === "bad-checksum" ? "0".repeat(64) : tarHash;
    const body = request.url.endsWith(filename) ? tar : Buffer.from(`${sum}  ${filename}\n`);
    sentBytes += body.length;
    if (sentBytes > 1048576) {
      unexpected = "body-limit";
      response.destroy();
      return;
    }
    response.writeHead(200, { "Content-Length": body.length });
    if (request.url.endsWith(filename) && mode === "hold-body") {
      response.write(body.subarray(0, 10));
      onHeld();
      return;
    }
    response.end(body);
  });
  origin.on("connection", track);
  origin.on("clientError", (_error, socket) => socket.destroy());
  const listen = (server) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  await listen(origin);
  const port = origin.address().port;
  const proxy = http.createServer((_request, response) => {
    unexpected = "non-CONNECT-proxy-request";
    response.writeHead(400).end();
  });
  proxy.on("connection", track);
  proxy.on("clientError", (_error, socket) => socket.destroy());
  proxy.on("connect", (request, downstream, head) => {
    proxyConnects++;
    if (proxyConnects > 16 || !proxyTargetAllowed(request.url, port)) {
      unexpected = "proxy-target-refused";
      downstream.destroy();
      return;
    }
    const upstream = track(net.connect({ host: "127.0.0.1", port }));
    upstream.once("connect", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) {
        upstream.write(head);
      }
      downstream.pipe(upstream).pipe(downstream);
    });
    downstream.once("close", () => upstream.destroy());
    upstream.once("close", () => downstream.destroy());
  });
  try {
    await listen(proxy);
  } catch (error) {
    await new Promise((resolve) => {
      origin.close(resolve);
    });
    throw error;
  }
  return {
    nonce,
    origin: `http://127.0.0.1:${port}`,
    distUrl: `http://127.0.0.1:${port}/${nonce}`,
    url: `http://127.0.0.1:${port}${prefix}${filename}`,
    proxy: `http://127.0.0.1:${proxy.address().port}`,
    get counts() {
      return {
        requests: [...requests],
        proxyConnects,
        connections,
        sentBytes,
        openSockets: sockets.size,
        unexpected,
      };
    },
    async waitClosed() {
      if (!sockets.size) {
        return;
      }
      await new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          empty.off("empty", finish);
          resolve();
        };
        const timer = setTimeout(() => {
          empty.off("empty", finish);
          reject(new Error("consumer sockets did not close"));
        }, 1000);
        empty.on("empty", finish);
        if (!sockets.size) {
          finish();
        }
      });
    },
    async close() {
      const before = sockets.size;
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all(
        [origin, proxy].map(
          (server) =>
            new Promise((resolve) => {
              server.close(resolve);
            }),
        ),
      );
      assert.equal(sockets.size, 0);
      return { openBeforeCleanup: before, openAfterCleanup: 0 };
    },
  };
}
