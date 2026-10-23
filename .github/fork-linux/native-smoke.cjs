// Synthetic installed-package ABI and forward/backward state checks.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const [prefix, state, mode] = process.argv.slice(2);
assert.ok(prefix && state && ["initial", "candidate", "rollback"].includes(mode));
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
const modules = path.join(prefix, "node_modules");
const req = createRequire(path.join(modules, "openclaw", "package.json"));
const files = [
  "sqlite-vec-linux-x64/vec0.so",
  "@openclaw/fs-safe-linux-x64-gnu/fs-safe-native.node",
  "@koromix/koffi-linux-x64/linux_x64/koffi.node",
  "@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node",
  "@ubjs/node-linux-x64-gnu/uniffi-runtime-napi.linux-x64-gnu.node",
  "@trycua/cua-driver-linux-x64-gnu/cua_driver_node_runtime.node",
  "@earendil-works/pi-tui/native/linux/prebuilds/linux-x64/linux-platform-x11.node",
];
function nativeFile(relative) {
  // npm may nest a package under OpenClaw when versions cannot be hoisted.
  for (const root of [modules, path.join(modules, "openclaw", "node_modules")]) {
    const candidate = path.join(root, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Missing required native module: ${relative}`);
}
const report = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  mode,
  native: [],
};
(async () => {
  for (const name of files) {
    const file = nativeFile(name);
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const exports = name.endsWith(".node") ? Object.keys(req(file)).length : null;
    report.native.push({ name, sha256, loaded: exports !== null, exports });
  }
  fs.mkdirSync(state, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(state, "compat.db"), { allowExtension: true });
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, body TEXT NOT NULL)",
    );
    const before = db
      .prepare("SELECT body FROM events ORDER BY seq")
      .all()
      .map((row) => row.body);
    if (mode === "initial") {
      assert.deepEqual(before, []);
      db.prepare("INSERT INTO events VALUES(?,?)").run(1, "retained-original");
    } else if (mode === "candidate") {
      assert.deepEqual(before, ["retained-original"]);
      db.prepare("INSERT INTO events VALUES(?,?)").run(2, "candidate-write");
    } else {
      assert.deepEqual(before, ["retained-original", "candidate-write"]);
    }
    db.loadExtension(nativeFile("sqlite-vec-linux-x64/vec0.so"));
    report.native[0].loadedAsSqliteExtension = true;
    assert.equal(
      db.prepare("SELECT vec_distance_L2('[1,2,3]', '[1,2,3]') AS distance").get().distance,
      0,
    );
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    report.sqliteRows = db.prepare("SELECT count(*) AS count FROM events").get().count;
    report.vecVersion = db.prepare("SELECT vec_version() AS version").get().version;
  } finally {
    db.close();
  }
  const zlib = require("node:zlib");
  const body = Buffer.from("synthetic bounded event ".repeat(100));
  assert.deepEqual(zlib.zstdDecompressSync(zlib.zstdCompressSync(body)), body);
  assert.equal(req("koffi").load("libc.so.6").func("int getpid(void)")(), process.pid);
  const fsSafe = await import(pathToFileURL(req.resolve("@openclaw/fs-safe")).href);
  const workspace = path.join(state, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const root = await fsSafe.root(workspace);
  await root.write("proof.txt", "synthetic-only");
  assert.equal(fs.readFileSync(path.join(workspace, "proof.txt"), "utf8"), "synthetic-only");
  await assert.rejects(() => root.write("../escape.txt", "blocked"));
  const { Worker } = require("node:worker_threads");
  await new Promise((resolve, reject) => {
    const worker = new Worker(
      "const {parentPort}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');parentPort.postMessage(db.prepare('SELECT 42 AS value').get().value);db.close();",
      { eval: true },
    );
    let received = false;
    worker.on("message", (value) => {
      received = value === 42;
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      try {
        assert.equal(code, 0);
        assert.equal(received, true);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  report.passed = true;
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
