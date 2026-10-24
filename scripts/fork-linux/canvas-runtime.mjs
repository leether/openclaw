import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ENTRY = "dist/extensions/canvas/index.js";
export const BUNDLES = {
  v08: "dist/canvas-host/a2ui/a2ui.bundle.js",
  v09: "dist/canvas-host/a2ui/a2ui-v0.9.bundle.js",
};
export const RUNTIME_CASE_COUNTS = {
  registration: 2,
  jsonlAccepted: 2,
  jsonlRejected: 9,
  composition: 2,
};
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function ownedFile(root, relative) {
  assert.ok(!path.isAbsolute(relative) && !relative.split(/[\\/]/u).includes(".."));
  const file = path.join(root, relative);
  assert.ok(fs.lstatSync(file).isFile(), `Not a regular file: ${relative}`);
  assert.equal(fs.realpathSync(file), file, `Symlink component: ${relative}`);
  return file;
}
export function fileHash(file) {
  const stat = fs.statSync(file);
  assert.ok(stat.size > 0 && stat.size <= 32 * 1024 ** 2, "File size limit");
  return { sha256: sha(fs.readFileSync(file)), bytes: stat.size };
}
export function bundleHashes(root) {
  return Object.fromEntries(
    Object.entries(BUNDLES).map(([version, relative]) => [
      version,
      { path: relative, ...fileHash(ownedFile(root, relative)) },
    ]),
  );
}
export function verifyFiles(root, expected) {
  assert.ok(Object.keys(expected).length > 0 && Object.keys(expected).length <= 4096);
  for (const [relative, value] of Object.entries(expected)) {
    assert.ok(relative.startsWith("dist/"));
    assert.deepEqual(
      fileHash(ownedFile(root, relative)),
      value,
      `Changed closure file: ${relative}`,
    );
  }
}

export function exerciseRegisteredPlugin(plugin) {
  assert.equal(plugin.id, "canvas");
  assert.equal(typeof plugin.register, "function");
  const names = [
    "registerBoardWidgetContentKind",
    "registerHttpRoute",
    "registerWidgetPresenter",
    "registerNodeInvokePolicy",
    "registerTool",
    "registerNodeCliFeature",
  ];
  function register(enabled) {
    const registered = Object.fromEntries(names.map((name) => [name, []]));
    const forbidden = () => {
      throw new Error("Synthetic registration must not invoke a node");
    };
    const api = {
      id: "canvas",
      name: "Canvas",
      config: { plugins: { entries: { canvas: { config: { host: { enabled } } } } } },
      runtime: { nodes: { list: forbidden, invoke: forbidden } },
      ...Object.fromEntries(names.map((name) => [name, (...args) => registered[name].push(args)])),
    };
    assert.equal(plugin.register(api), undefined, "Registration must stay synchronous");
    return registered;
  }
  const enabled = register(true);
  for (const name of names) {
    assert.equal(enabled[name].length, 1, name);
  }
  const disabled = register(false);
  for (const name of names) {
    assert.equal(
      disabled[name].length,
      ["registerBoardWidgetContentKind", "registerHttpRoute", "registerWidgetPresenter"].includes(
        name,
      )
        ? 0
        : 1,
      name,
    );
  }
  const widget = enabled.registerBoardWidgetContentKind[0][0];
  assert.equal(widget.kind, "a2ui");
  assert.deepEqual(widget.resources.paths, [
    "/__openclaw__/a2ui/a2ui.bundle.js",
    "/__openclaw__/a2ui/a2ui-v0.9.bundle.js",
  ]);
  assert.equal(enabled.registerHttpRoute[0][0].path, "/__openclaw__/a2ui");
  assert.equal(enabled.registerHttpRoute[0][0].auth, "plugin");
  assert.deepEqual(enabled.registerNodeInvokePolicy[0][0].commands, [
    "canvas.present",
    "canvas.hide",
    "canvas.navigate",
  ]);
  const catalog = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";
  const messages09 = [
    { version: "v0.9", createSurface: { surfaceId: "synthetic", catalogId: catalog } },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "synthetic",
        components: [{ id: "root", component: "Text", text: "Synthetic <value>" }],
      },
    },
    {
      version: "v0.9",
      updateDataModel: { surfaceId: "synthetic", path: "/status", value: "ready" },
    },
    { version: "v0.9", deleteSurface: { surfaceId: "synthetic" } },
  ];
  const messages08 = [
    {
      surfaceUpdate: {
        surfaceId: "legacy",
        components: [
          {
            id: "root",
            component: { Text: { text: { literalString: "Synthetic </script> value" } } },
          },
        ],
      },
    },
    { beginRendering: { surfaceId: "legacy", root: "root" } },
  ];
  const jsonl = (messages) => messages.map((message) => JSON.stringify(message)).join("\n");
  const positive = [
    { version: "v08", messages: messages08, prompt: true },
    { version: "v09", messages: messages09, prompt: false },
  ];
  const assertions = ["installed-canvas-registration", "disabled-host-registration-policy"];
  for (const { version, messages, prompt } of positive) {
    const source = jsonl(messages);
    assert.equal(widget.validateSource(source), undefined);
    const resourceUrls = Object.fromEntries(widget.resources.paths.map((p) => [p, p]));
    const doc = widget.composeDocument({ source, resourceUrls, promptGranted: prompt });
    assert.equal(typeof doc, "string");
    const boot = doc.match(/^<script>globalThis\.openclawA2UIBoot=([^]*?);<\/script>/u);
    assert.ok(boot, `Missing boot data: ${version}`);
    assert.deepEqual(JSON.parse(boot[1]), { messages, actionTier: prompt ? "prompt" : "state" });
    assert.ok(!boot[1].includes("<"));
    assert.ok(doc.includes(version === "v09" ? "a2ui-v0.9.bundle.js" : "a2ui.bundle.js"));
    assertions.push(
      `installed-jsonl-${version}-accepted`,
      `installed-${version}-document-composed`,
    );
  }
  const negative = [
    ["empty", " \n", /no JSONL messages/u],
    ["invalid-json", "{", /line 1/u],
    ["array", "[]", /expected JSON object/u],
    [
      "explicit-v08",
      JSON.stringify({ version: "v0.8", deleteSurface: { surfaceId: "s" } }),
      /must not include/u,
    ],
    [
      "unknown-version",
      JSON.stringify({ version: "v1.0", deleteSurface: { surfaceId: "s" } }),
      /unsupported A2UI version/u,
    ],
    [
      "missing-catalog",
      JSON.stringify({ version: "v0.9", createSurface: { surfaceId: "s" } }),
      /line 1/u,
    ],
    [
      "unversioned-v09",
      JSON.stringify({ createSurface: { surfaceId: "s", catalogId: catalog } }),
      /v0.8 action key/u,
    ],
    ["mixed", jsonl([messages08[0], messages09[0]]), /mixed A2UI/u],
    ["extra-field", JSON.stringify({ ...messages09[0], extra: true }), /unexpected top-level/u],
  ];
  for (const [name, value, pattern] of negative) {
    assert.throws(() => widget.validateSource(value), pattern, name);
    assertions.push(`installed-jsonl-${name}-rejected`);
  }
  return { caseCounts: RUNTIME_CASE_COUNTS, assertions };
}

// Capture only modules actually resolved/loaded by the named consumer cases.
// This is not a claim that all lazy Canvas/tool/CLI paths were exercised.
export async function exerciseCanvas(root) {
  assert.equal(typeof registerHooks, "function");
  assert.ok(
    !/^(1|true|yes|on)$/iu.test(process.env.OPENCLAW_SKIP_CANVAS_HOST ?? ""),
    "Inherited Canvas skip flag",
  );
  const entry = ownedFile(root, ENTRY);
  const coreFiles = new Set();
  const externalModules = new Set();
  const note = (url) => {
    if (!url.startsWith("file:")) {
      return;
    }
    const file = fs.realpathSync(fileURLToPath(url));
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (relative.startsWith("dist/")) {
      coreFiles.add(relative);
      assert.ok(coreFiles.size <= 4096, "Runtime closure count limit");
    } else if (file.includes(`${path.sep}node_modules${path.sep}`)) {
      // Resolution graph/audit belongs to the install qualifier; no absolute path output.
      externalModules.add(sha(file));
    }
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      note(result.url);
      return result;
    },
    load(url, context, next) {
      note(url);
      return next(url, context);
    },
  });
  let tested;
  try {
    tested = exerciseRegisteredPlugin((await import(pathToFileURL(entry))).default);
  } finally {
    hooks.deregister();
  }
  assert.ok(coreFiles.has(ENTRY));
  let total = 0;
  const runtimeClosure = Object.fromEntries(
    [...coreFiles]
      .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((relative) => {
        const value = fileHash(ownedFile(root, relative));
        total += value.bytes;
        assert.ok(total <= 128 * 1024 ** 2, "Runtime closure byte limit");
        return [relative, value];
      }),
  );
  return {
    ...tested,
    runtimeClosure,
    closureBytes: total,
    externalModuleCount: externalModules.size,
    closureScope:
      "Exact core files resolved/loaded by Canvas registration, JSONL and composition; external dependency graph/audit separately qualified.",
  };
}
