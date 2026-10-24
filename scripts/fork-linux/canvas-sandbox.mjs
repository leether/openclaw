import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function small(file) {
  const fd = fs.openSync(file, "r");
  try {
    const bytes = Buffer.alloc(32769);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    assert.ok(count <= 32768, "Sandbox receipt/status output cap");
    return bytes.subarray(0, count).toString().trim();
  } finally {
    fs.closeSync(fd);
  }
}
export function verifySandboxStatus(status) {
  for (const key of ["userNs", "pidNs", "netNs", "seccompBpf", "seccompTsync", "sandboxGood"]) {
    assert.equal(status[key], true, `Chromium sandbox ${key}`);
  }
  assert.equal(
    status.suid,
    false,
    "This qualifier uses the namespace sandbox, not a setuid helper",
  );
}
export function parseRendererStatus(text) {
  const field = (name) => {
    const rows = text.split("\n").filter((x) => x.startsWith(name + ":"));
    assert.equal(rows.length, 1, `Missing/duplicate renderer ${name}`);
    return rows[0].split(":")[1].trim();
  };
  assert.equal(field("Seccomp"), "2");
  assert.equal(field("NoNewPrivs"), "1");
  return { seccomp: 2, noNewPrivs: 1 };
}
export function openSandboxAuthority(executable) {
  assert.equal(process.platform, "linux");
  const directory = process.env.CANVAS_SANDBOX_OWNER;
  assert.match(directory ?? "", /^\/run\/openclaw-canvas-[a-f0-9]{32}$/u);
  for (const file of [
    "/run",
    directory,
    path.join(directory, "receipt.json"),
    path.join(directory, "loaded.json"),
  ]) {
    const s = fs.lstatSync(file);
    assert.equal(s.isSymbolicLink(), false);
    assert.equal(s.uid, 0);
    assert.equal(s.mode & 0o022, 0);
  }
  const receipt = JSON.parse(small(path.join(directory, "receipt.json")));
  const loaded = JSON.parse(small(path.join(directory, "loaded.json")));
  assert.equal(receipt.profile, path.basename(directory));
  assert.equal(receipt.executable.path, executable);
  assert.equal(receipt.runnerUid, process.getuid());
  assert.deepEqual(loaded, { passed: true, profile: receipt.profile, globalPolicyUnchanged: true });
  assert.equal(
    small("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
    receipt.usernsRestriction,
  );
  assert.equal(receipt.usernsRestriction, "1");
  assert.equal(fs.realpathSync(executable), executable);
  const fd = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    assert.equal(s.isFile(), true);
    assert.equal(String(s.dev), receipt.executable.dev);
    assert.equal(String(s.ino), receipt.executable.inode);
    assert.equal(s.size, receipt.executable.bytes);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 ** 2);
    let offset = 0,
      count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, offset))) {
      hash.update(buffer.subarray(0, count));
      offset += count;
      assert.ok(offset <= 512 * 1024 ** 2);
    }
    assert.equal(hash.digest("hex"), receipt.executable.sha256);
    return { fd, receipt, close: () => fs.closeSync(fd) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
export async function attestRenderers(browser, leaderPid) {
  const session = await browser.newBrowserCDPSession();
  try {
    const processes = await session.send("SystemInfo.getProcessInfo");
    const selected = processes.processInfo.filter((x) => x.type === "renderer");
    assert.ok(selected.length > 0 && selected.length <= 32);
    const ownCgroup = small(`/proc/${leaderPid}/cgroup`);
    assert.equal(ownCgroup, small("/proc/self/cgroup"), "Browser escaped its worker cgroup");
    return selected.map((x) => {
      assert.ok(Number.isSafeInteger(x.id) && x.id > 1);
      assert.equal(
        small(`/proc/${x.id}/cgroup`),
        ownCgroup,
        "Renderer must stay in the browser's owned cgroup",
      );
      return Object.assign({ pid: x.id }, parseRendererStatus(small(`/proc/${x.id}/status`)));
    });
  } finally {
    await session.detach();
  }
}
export async function attestSandbox(browser, pid, authority) {
  const { receipt, fd } = authority;
  const held = fs.fstatSync(fd);
  const live = fs.statSync(`/proc/${pid}/exe`);
  assert.equal(live.dev, held.dev);
  assert.equal(live.ino, held.ino);
  assert.equal(fs.readlinkSync(`/proc/${pid}/exe`), receipt.executable.path);
  const label = small(`/proc/${pid}/attr/apparmor/current`);
  assert.equal(
    label,
    `${receipt.profile} (unconfined)`,
    "Exact temporary AppArmor attachment required",
  );
  const context = await browser.newContext({ serviceWorkers: "block" });
  let status, renderers;
  try {
    const page = await context.newPage();
    await page.goto("chrome://sandbox", { waitUntil: "load", timeout: 4000 });
    status = await page.evaluate(async () => {
      // Chromium's own Linux status page imports this official module.
      const { loadTimeData } = await import("chrome://resources/js/load_time_data.js");
      return Object.fromEntries(
        ["suid", "userNs", "pidNs", "netNs", "seccompBpf", "seccompTsync", "sandboxGood"].map(
          (key) => [key, loadTimeData.getBoolean(key)],
        ),
      );
    });
    verifySandboxStatus(status);
    renderers = await attestRenderers(browser, pid);
  } finally {
    await context.close();
  }
  return {
    passed: true,
    leaderPid: pid,
    label,
    executable: receipt.executable,
    policySha256: receipt.policySha256,
    chromiumStatus: status,
    renderers,
    limitation:
      "Exact default path is writable by the trusted CI runner; held FD/live inode bind this launch but do not defeat a concurrent privileged writer",
  };
}
