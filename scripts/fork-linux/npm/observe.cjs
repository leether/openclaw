// Read-only diagnostic subscription: do not replace fetch, require or dispatchers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const dc = require("node:diagnostics_channel");
const config = JSON.parse(fs.readFileSync(process.env.NPM_CONSUMER_CONFIG, "utf8"));
let count = 0;
function record(kind, message) {
  assert.ok(++count <= 16);
  const download = path.join(config.npmRoot, "node_modules/node-gyp/lib/download.js");
  const resolve = createRequire(download);
  const entry = fs.realpathSync(resolve.resolve("undici"));
  const meta = fs.realpathSync(resolve.resolve("undici/package.json"));
  const expectedEntry = fs.realpathSync(path.join(config.npmRoot, "node_modules/undici/index.js"));
  assert.equal(entry, expectedEntry);
  assert.ok(require.cache[download] && require.cache[entry]);
  const data = fs.readFileSync(meta);
  assert.equal(JSON.parse(data).version, config.expectedUndici);
  const request = message.request;
  const transport = request.method === "CONNECT" ? "proxy" : "origin";
  let pathname;
  if (transport === "proxy") {
    assert.equal(new URL(request.origin).origin, config.proxy);
    assert.equal(request.path, new URL(config.origin).host);
    pathname = "CONNECT";
  } else {
    const url = new URL(request.path, request.origin);
    assert.equal(url.origin, config.origin);
    assert.ok(url.pathname.startsWith("/" + config.nonce + "/"));
    pathname = url.pathname;
  }
  const event = {
    kind,
    transport,
    nonce: config.nonce,
    pid: process.pid,
    download: path.relative(config.npmRoot, download),
    undiciEntry: path.relative(config.npmRoot, entry),
    undiciVersion: config.expectedUndici,
    undiciPackageSha256: createHash("sha256").update(data).digest("hex"),
    pathname,
  };
  process.stderr.write("NPM_CONSUMER_EVENT " + JSON.stringify(event) + "\n");
}
dc.channel("undici:request:create").subscribe((message) => record("request", message));
dc.channel("undici:request:headers").subscribe((message) => record("headers", message));
