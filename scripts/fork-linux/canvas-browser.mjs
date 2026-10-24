import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile, mkdir, stat, mkdtemp, realpath, lstat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { openSandboxAuthority, attestSandbox, attestRenderers } from "./canvas-sandbox.mjs";
export function createBrowserOutputBudget() {
  let bytes = 0,
    limitExceeded = false;
  return {
    observe(chunk) {
      bytes += chunk.length;
      limitExceeded ||= bytes > 32768;
      return !limitExceeded;
    },
    snapshot() {
      return { bytes, limitBytes: 32768, limitExceeded };
    },
  };
}
export function finalizeBrowserOutput(result, budget) {
  result.browserOutput = budget.snapshot();
  if (result.browserOutput.limitExceeded) {
    result.passed = false;
    result.error ??= "Chromium combined output exceeded 32KiB";
  }
}
// Chromium creates its singleton Unix socket beneath TMPDIR. Keep this separate
// from the long evidence/profile path and below the portable sockaddr_un limit.
export function verifyBrowserTemporaryPath(directory) {
  assert.ok(path.isAbsolute(directory) && !directory.includes("\0"));
  const socket = path.join(directory, "org.chromium.Chromium.XXXXXX", "SingletonSocket");
  assert.ok(Buffer.byteLength(socket) < 104, "Chromium temporary socket path exceeds 103 bytes");
  return socket;
}
export async function createBrowserTemporaryDirectory() {
  // Never inherit TMPDIR: hosted checkout and artifact paths can exceed sun_path.
  const directory = await realpath(await mkdtemp("/tmp/oc-canvas-"));
  const metadata = await lstat(directory);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
  assert.equal(metadata.uid, process.getuid());
  assert.equal(metadata.mode & 0o777, 0o700);
  verifyBrowserTemporaryPath(directory);
  return {
    path: directory,
    uid: metadata.uid,
    mode: metadata.mode & 0o777,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    retainedUntilRunnerTeardown: true,
  };
}
export async function runBrowserProof({
  root,
  playwrightRoot,
  bundles,
  captureSha256,
  sandboxOnly = false,
}) {
  const label = "installed-restored-canvas";
  const output = path.join(root, "evidence", label + ".result.json");
  const profile = path.join(root, "state", label);
  await mkdir(profile, { recursive: false });
  const require = createRequire(path.join(playwrightRoot, "ui", "package.json"));
  const { chromium } = require("playwright");
  const executable = chromium.executablePath();
  assert.ok((await stat(executable)).isFile()); // Missing managed browser fails; never download.
  const sha = (x) => createHash("sha256").update(x).digest("hex");
  const result = {
    schemaVersion: 1,
    phase: "browser",
    label,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    captureSha256,
    playwright: require("playwright/package.json").version,
    executable,
    defaultPlaywrightExecutable: executable,
    profile,
    results: [],
    externalRequestsBlocked: [],
    pageErrors: [],
    console: [],
    requests: [],
    cleanup: {},
    scope:
      "synthetic actual installed/restored Canvas bundle consumers; platform stated explicitly; no general custom-schema or LIVE claim",
  };
  const assets = new Map();
  for (const lane of sandboxOnly ? [] : ["installed", "restored"]) {
    for (const version of ["v08", "v09"]) {
      const file = bundles[lane][version];
      const bytes = await readFile(file);
      assets.set(`/${lane}/${version}.js`, bytes);
      result.results.push({
        lane,
        version,
        bundleSha256: sha(bytes),
        tests: [],
        status: "pending",
      });
    }
  }
  const fixture =
    "globalThis.canvasProofActions=[];globalThis.openclaw={state:{emit:async x=>{globalThis.canvasProofActions.push(x)}}};globalThis.openclawA2UIBoot={actionTier:'state',messages:[]};";
  result.networkBoundary = {
    chromiumNativeSandboxRetained: false,
    outerSeatbelt: false,
    reason:
      "Native browser sandbox plus exact-origin route and WebSocket blocking for reviewed synthetic-only proof; no OS network isolation assertion",
    serviceWorkers: "block",
    requestScope: "exact loopback origin only",
    externalNetworkKernelEnforcement: false,
  };
  result.webSocketsBlocked = [];
  const server = createServer((req, res) => {
    result.requests.push({ path: req.url, method: req.method });
    assert.ok(result.requests.length < 50);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; font-src 'none'; base-uri 'none'; form-action 'none'",
    );
    if (req.url === "/fixture.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(fixture);
      return;
    }
    if (assets.has(req.url)) {
      res.setHeader("Content-Type", "text/javascript");
      res.end(assets.get(req.url));
      return;
    }
    if (/^\/(installed|restored)\/(v08|v09)$/.test(req.url)) {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Synthetic Canvas proof</title><style>body{font-family:Arial;padding:24px;color:#111;background:#fff}</style><script src="/fixture.js"></script><openclaw-a2ui-host></openclaw-a2ui-host><script type="module" src="${req.url}.js"></script>`,
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  let child, browser, closed, sandboxAuthority;
  let stderr = "";
  const outputBudget = createBrowserOutputBudget();
  try {
    result.temporaryDirectory = await createBrowserTemporaryDirectory();
    sandboxAuthority = openSandboxAuthority(executable);
    const args = [
      "--headless",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--disable-domain-reliability",
      "--disable-default-apps",
      "--disable-features=OptimizationHints,MediaRouter,AutofillServerCommunication,CertificateTransparencyComponentUpdater",
      "--disk-cache-size=1048576",
      "--media-cache-size=1048576",
      "--js-flags=--max-old-space-size=512",
      "about:blank",
    ];
    child = spawn(executable, args, {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: profile,
        XDG_CONFIG_HOME: profile,
        XDG_CACHE_HOME: profile,
        TMPDIR: result.temporaryDirectory.path,
        LANG: "C.UTF-8",
      },
    });
    result.browserPid = child.pid;
    result.browserInheritsSupervisorGroup = true;
    closed = once(child, "close");
    closed.catch(() => {});
    child.stdout.on("data", (b) => {
      if (!outputBudget.observe(b)) {
        child.kill("SIGTERM");
      }
    });
    const ws = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("browser admission timeout")), 8000);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error("browser spawn failed", { cause: e }));
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`browser exited before admission ${code}/${signal}`));
      });
      child.stderr.on("data", (b) => {
        if (!outputBudget.observe(b)) {
          clearTimeout(timer);
          child.kill("SIGTERM");
          reject(new Error("browser output limit"));
          return;
        }
        stderr += b.toString();
        const m = stderr.match(
          /DevTools listening on (ws:\/\/127\.0\.0\.1:[0-9]+\/devtools\/browser\/[^\s]+)/,
        );
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
    });
    browser = await chromium.connectOverCDP(ws, { timeout: 8000 });
    result.browserVersion = browser.version();
    result.sandbox = await attestSandbox(browser, child.pid, sandboxAuthority);
    result.networkBoundary.chromiumNativeSandboxRetained = true;
    for (const row of result.results) {
      const context = await browser.newContext({
        viewport: { width: 960, height: 700 },
        serviceWorkers: "block",
      });
      await context.route("**/*", (route) => {
        if (new URL(route.request().url()).origin === origin) {
          return route.continue();
        }
        result.externalRequestsBlocked.push({
          lane: row.lane,
          version: row.version,
          url: route.request().url(),
        });
        return route.abort("blockedbyclient");
      });
      assert.equal(typeof context.routeWebSocket, "function");
      await context.routeWebSocket("**/*", (socketRoute) => {
        result.webSocketsBlocked.push(socketRoute.url());
        return socketRoute.close({ code: 1008, reason: "synthetic proof does not use WebSockets" });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(4000);
      page.on("pageerror", (e) =>
        result.pageErrors.push({
          lane: row.lane,
          version: row.version,
          error: e.message.slice(0, 1000),
        }),
      );
      page.on("console", (m) => {
        if (["error", "warning"].includes(m.type()) && result.console.length < 40) {
          result.console.push({
            lane: row.lane,
            version: row.version,
            type: m.type(),
            text: m.text().slice(0, 500),
          });
        }
      });
      try {
        await page.goto(`${origin}/${row.lane}/${row.version}`, {
          waitUntil: "load",
          timeout: 8000,
        });
        await page.waitForFunction(
          () => typeof globalThis.openclawA2UI?.applyMessages === "function",
        );
        row.tests.push("exact-host-bundle-loaded");
        const apply = (messages) =>
          page.evaluate((payload) => globalThis.openclawA2UI.applyMessages(payload), messages);
        if (row.version === "v09") {
          const version = "v0.9";
          const surfaceId = "synthetic-surface";
          const initial = [
            {
              version,
              createSurface: {
                surfaceId,
                catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
              },
            },
            {
              version,
              updateDataModel: { surfaceId, value: { title: "Synthetic initial", name: "Ada" } },
            },
            {
              version,
              updateComponents: {
                surfaceId,
                components: [
                  { id: "root", component: "Column", children: ["heading", "input", "button"] },
                  { id: "heading", component: "Text", text: { path: "/title" } },
                  { id: "input", component: "TextField", label: "Name", value: { path: "/name" } },
                  {
                    id: "button",
                    component: "Button",
                    child: "button-label",
                    action: {
                      event: { name: "synthetic-submit", context: { name: { path: "/name" } } },
                    },
                  },
                  { id: "button-label", component: "Text", text: "Synthetic submit" },
                ],
              },
            },
          ];
          assert.deepEqual((await apply(initial)).surfaces, [surfaceId]);
          await page.getByText("Synthetic initial", { exact: true }).waitFor();
          assert.equal(await page.getByRole("textbox").inputValue(), "Ada");
          assert.equal(await page.getByRole("button", { name: "Synthetic submit" }).count(), 1);
          row.tests.push("child-refs-and-omitted-defaults-rendered");
          await apply([
            { version, updateDataModel: { surfaceId, path: "/title", value: "Synthetic updated" } },
          ]);
          await page.getByText("Synthetic updated", { exact: true }).waitFor();
          row.tests.push("model-path-update-rendered");
          await page.getByRole("textbox").fill("Grace");
          await page.getByRole("button", { name: "Synthetic submit" }).click();
          await page.waitForFunction(() => globalThis.canvasProofActions.length === 1);
          const event = await page.evaluate(() => globalThis.canvasProofActions[0]);
          assert.equal(event.eventType, "a2ui.action");
          assert.equal(event.action.name, "synthetic-submit");
          assert.equal(event.action.context.name, "Grace");
          row.action = { name: event.action.name, context: event.action.context };
          row.tests.push("two-way-input-and-action-context");
          await page.screenshot({
            path: path.join(root, "evidence", `${label}-${row.lane}-${row.version}.png`),
          });
          await apply([{ version, deleteSurface: { surfaceId } }]);
          assert.deepEqual(await page.evaluate(() => globalThis.openclawA2UI.getSurfaces()), []);
          row.tests.push("surface-delete");
        } else {
          const surfaceId = "synthetic-surface";
          await apply([
            {
              surfaceUpdate: {
                surfaceId,
                components: [
                  {
                    id: "root",
                    component: {
                      Text: { text: { literalString: "Synthetic initial" }, usageHint: "body" },
                    },
                  },
                ],
              },
            },
            { beginRendering: { surfaceId, root: "root" } },
          ]);
          await page.getByText("Synthetic initial", { exact: true }).waitFor();
          row.tests.push("v08-text-rendered");
          await apply([
            {
              surfaceUpdate: {
                surfaceId,
                components: [
                  {
                    id: "root",
                    component: {
                      Text: { text: { literalString: "Synthetic updated" }, usageHint: "body" },
                    },
                  },
                ],
              },
            },
          ]);
          await page.getByText("Synthetic updated", { exact: true }).waitFor();
          row.tests.push("v08-component-update");
          await page.screenshot({
            path: path.join(root, "evidence", `${label}-${row.lane}-${row.version}.png`),
          });
        }
        assert.deepEqual(await page.evaluate(() => globalThis.openclawA2UI.reset()), { ok: true });
        assert.deepEqual(await page.evaluate(() => globalThis.openclawA2UI.getSurfaces()), []);
        row.tests.push("reset-clears-surfaces");
        const errors = result.pageErrors.filter(
          (x) => x.lane === row.lane && x.version === row.version,
        );
        assert.deepEqual(errors, []);
        row.sandboxRenderers = await attestRenderers(browser, child.pid);
        row.status = "passed";
      } catch (error) {
        row.status = "failed";
        row.error = String(error.message).slice(0, 1500);
      } finally {
        await context.close();
      }
    }
    assert.equal(result.results.filter((x) => x.status === "passed").length, sandboxOnly ? 0 : 4);
    assert.deepEqual(result.externalRequestsBlocked, []);
    assert.deepEqual(result.webSocketsBlocked, []);
    assert.equal(result.requests.length, sandboxOnly ? 0 : 12);
    assert.ok(result.requests.every((r) => r.method === "GET"));
    result.passed = true;
  } catch (error) {
    result.passed = false;
    result.error = String(error.message).slice(0, 2000);
  } finally {
    if (browser) {
      try {
        await browser.close();
        result.cleanup.cdpClosed = true;
      } catch (error) {
        result.cleanup.closeError = error.message;
        result.passed = false;
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    if (closed) {
      try {
        result.cleanup.childClose = await Promise.race([
          closed,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("child pipes close timeout")), 2000);
          }),
        ]);
      } catch (error) {
        result.cleanup.error = error.message;
        child.kill("SIGKILL");
        result.passed = false;
        try {
          result.cleanup.childCloseAfterKill = await Promise.race([
            closed,
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error("post-KILL pipes close timeout")), 2000);
            }),
          ]);
        } catch (killError) {
          result.cleanup.killError = killError.message;
        }
      }
    }
    sandboxAuthority?.close();
    server.closeAllConnections();
    await new Promise((resolve) => {
      server.close(resolve);
    });
    result.cleanup.serverClosed = true;
    finalizeBrowserOutput(result, outputBudget);
    result.browserStderr = stderr;
    result.cleanup.browserLeaderExited = Boolean(
      child && (child.exitCode !== null || child.signalCode !== null),
    );
    if (!result.cleanup.browserLeaderExited) {
      result.passed = false;
    }
    result.cleanup.requiresOuterProcessTreeVerification = true;
    result.caseCounts = {
      combinations: result.results.length,
      passed: result.results.filter((x) => x.status === "passed").length,
      steps: result.results.reduce((n, x) => n + x.tests.length, 0),
    };
    result.browser = {
      version: result.browserVersion,
      playwright: result.playwright,
      defaultExecutable: executable,
    };
    await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  }
  return result;
}
