import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const [pkgRoot, format = "mjs", expectedVisits = "0"] = process.argv.slice(2);
const load = async (name) =>
  format === "cjs"
    ? require(resolve(pkgRoot, "output", `${name}.cjs`))
    : import(pathToFileURL(resolve(pkgRoot, "output", `${name}.mjs`)));
const schemas = await load("schema/index");
const { Message, ScopesObject } = await load("schema/common");
const { fallbackToDefault, zodCoerceUnhandledValue } = await load("utils/zodUtils");
const { getChannel } = await load("commands/getChannel");
const { authenticate } = await load("commands/authenticate");
const { openExternalLink } = await load("commands/openExternalLink");
const compat = await load("utils/compatCommandFactory");
let checks = 0;
const same = (a, b) => {
  assert.deepEqual(a, b);
  checks++;
};
const rejects = (fn) => {
  assert.throws(fn);
  checks++;
};
const user = {
  id: "1",
  username: "fixture",
  discriminator: "0001",
  avatar_decoration_data: null,
  bot: false,
};
const msg = {
  id: "m1",
  channel_id: "c1",
  author: user,
  content: "fixture",
  timestamp: "2026-01-01T00:00:00Z",
  tts: false,
  mention_everyone: false,
  mentions: [],
  mention_roles: [],
  mention_channels: [],
  attachments: [],
  embeds: [],
  pinned: false,
  type: 0,
};
const channel = { id: "c1", type: 999, voice_states: [], messages: [msg], future: "strip" };
const auth = {
  access_token: "synthetic",
  user: { id: "1", username: "fixture", discriminator: "0001", public_flags: 0 },
  scopes: ["identify", "future.scope", -1, null],
  expires: "future",
  application: { id: "app", name: "fixture", description: "" },
};
const response = (cmd, data) => ({ cmd, evt: null, nonce: "nonce", data });
const ready = {
  cmd: "DISPATCH",
  evt: "READY",
  nonce: null,
  data: {
    v: 1,
    config: { api_endpoint: "loopback.invalid", environment: "synthetic" },
    future: "strip",
  },
  futureOuter: true,
};
same(schemas.parseIncomingPayload(ready), { ...ready, data: { v: 1, config: ready.data.config } });
same(schemas.parseIncomingPayload(response("AUTHENTICATE", auth)).data.scopes, [
  "identify",
  -1,
  -1,
  -1,
]);
same(schemas.parseIncomingPayload(response("GET_CHANNEL", channel)).data, {
  id: "c1",
  type: -1,
  voice_states: [],
  messages: [msg],
});
same(schemas.parseIncomingPayload(response("OPEN_EXTERNAL_LINK", { opened: "future" })).data, {
  opened: null,
});
same(schemas.parseIncomingPayload(response("OPEN_EXTERNAL_LINK", { opened: true })).data, {
  opened: true,
});
same(
  schemas.parseIncomingPayload({
    cmd: "AUTHORIZE",
    evt: "ERROR",
    nonce: "nonce",
    data: { code: 4000, message: "synthetic", future: true },
  }).data,
  { code: 4000, message: "synthetic", future: true },
);
same(
  schemas.parseIncomingPayload({
    cmd: "DISPATCH",
    evt: "CURRENT_USER_UPDATE",
    nonce: null,
    data: user,
  }).data,
  user,
);
for (const bad of [
  { ...ready, cmd: "bad" },
  { ...ready, evt: "NEW_EVENT" },
  response("GET_CHANNEL", { ...channel, id: 3 }),
  response("GET_CHANNEL", { id: "c1", type: 1 }),
  { ...response("AUTHENTICATE", auth), nonce: null },
  response("AUTHENTICATE", { ...auth, user: { id: "1" } }),
]) {
  rejects(() => schemas.parseIncomingPayload(bad));
}
for (const value of ["known", "new", 9, -1]) {
  same(
    zodCoerceUnhandledValue({ UNHANDLED: -1, KNOWN: "known" }).parse(value),
    value === "known" ? "known" : -1,
  );
}
for (const value of [null, undefined]) {
  rejects(() => zodCoerceUnhandledValue({ UNHANDLED: -1, KNOWN: "known" }).parse(value));
}
same(zodCoerceUnhandledValue({ UNHANDLED: -1, KNOWN: "known" }).nullish().parse(null), null);
same(
  zodCoerceUnhandledValue({ UNHANDLED: -1, KNOWN: "known" }).optional().parse(undefined),
  undefined,
);
same(ScopesObject.identify, "identify");
same(ScopesObject.UNHANDLED, -1);
const fallback = fallbackToDefault(Message.shape.content.default("fallback"));
for (const [value, want] of [
  ["hello", "hello"],
  [null, "fallback"],
  [undefined, "fallback"],
  [42, "fallback"],
]) {
  same(fallback.parse(value), want);
}
rejects(() => fallback.overlayType.parse(null));
same(fallback.overlayType.parse(undefined), "fallback");
let generated = 0;
const dynamic = fallbackToDefault(Message.shape.content.default(() => `v${++generated}`));
same(dynamic.parse(null), "v1");
same(dynamic.parse(undefined), "v2");
same(dynamic.parse("fixed"), "fixed");
same(generated, 2);
const sent = [];
const send = async (payload) => {
  sent.push(payload);
  return response(payload.cmd, channel);
};
same((await getChannel(send)({ channel_id: "c1" })).messages, [msg]);
same(sent.length, 1);
same(sent[0].cmd, "GET_CHANNEL");
same(sent[0].args, { channel_id: "c1" });
await assert.rejects(getChannel(async () => response("AUTHORIZE", channel))({ channel_id: "c1" }));
checks++;
await assert.rejects(
  getChannel(async () => response("GET_CHANNEL", { id: 9 }))({ channel_id: "c1" }),
);
checks++;
same(
  (await authenticate(async (p) => response(p.cmd, auth))({ access_token: "synthetic" })).scopes,
  ["identify", -1, -1, -1],
);
same(
  await openExternalLink(async (p) => response(p.cmd, { opened: "future" }))({
    url: "https://invalid.example",
  }),
  { opened: null },
);
const tries = [];
const compatFactory = compat.default;
const command = compatFactory({
  sendCommand: async (p) => {
    tries.push(p);
    if (tries.length === 1) {
      throw Object.assign(new Error("synthetic invalid payload"), { code: 4000 });
    }
    return response(p.cmd, "ok");
  },
  cmd: "AUTHORIZE",
  response: Message.shape.content,
  fallbackTransform: () => ({ legacy: true }),
});
same(await command({ new: true }), "ok");
same(
  tries.map((p) => p.args),
  [{ new: true }, { legacy: true }],
);
let errors = 0;
await assert.rejects(
  compatFactory({
    sendCommand: async () => {
      errors++;
      throw new Error("synthetic");
    },
    cmd: "AUTHORIZE",
    response: Message.shape.content,
    fallbackTransform: () => ({ legacy: true }),
  })({ new: true }),
);
checks++;
same(errors, 1);
// Keep the original parser cases above and separately exercise the real SDK's
// plain-object ERROR rejection through its native compatibility command.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const nativeFrames = [];
const nativeListeners = new Set();
const nativeRejections = [];
let nativeSdk;
try {
  globalThis.window = {
    location: {
      origin: "https://fixture.invalid",
      search: "?frame_id=f&instance_id=i&platform=desktop&channel_id=c",
    },
    parent: {
      postMessage: ([opcode, payload]) => {
        if (opcode !== 1) {
          return;
        }
        nativeFrames.push(payload);
        const incoming =
          nativeFrames.length === 1
            ? {
                cmd: payload.cmd,
                evt: "ERROR",
                nonce: payload.nonce,
                data: { code: 4000, message: "synthetic invalid payload" },
              }
            : { cmd: payload.cmd, evt: null, nonce: payload.nonce, data: {} };
        // sendCommand registers its Promise after postMessage returns.
        queueMicrotask(() => {
          for (const listener of nativeListeners) {
            listener({ data: [1, incoming], origin: "https://discord.com" });
          }
        });
      },
    },
    addEventListener: (kind, listener) => {
      assert.equal(kind, "message");
      nativeListeners.add(listener);
    },
    removeEventListener: (kind, listener) => {
      assert.equal(kind, "message");
      nativeListeners.delete(listener);
    },
  };
  globalThis.document = { referrer: "https://discord.com" };
  const { DiscordSDK } = await load("index");
  const { setOrientationLockState } = await load("commands/setOrientationLockState");
  nativeSdk = new DiscordSDK("synthetic", { disableConsoleLogOverride: true });
  const nativeCommand = setOrientationLockState((payload) => {
    const pending = nativeSdk.sendCommand(payload);
    // Observe the exact native rejection without replacing the Promise or value
    // that the installed compatibility factory receives.
    void pending.catch((error) => {
      nativeRejections.push(error);
    });
    return pending;
  });
  const primaryArgs = {
    lock_state: 1,
    picture_in_picture_lock_state: 2,
    grid_lock_state: 3,
  };
  assert.deepEqual(await nativeCommand(primaryArgs), {});
  assert.equal(nativeRejections.length, 1);
  assert.equal(nativeRejections[0] instanceof Error, false);
  assert.equal(Object.getPrototypeOf(nativeRejections[0]), Object.prototype);
  assert.deepEqual(nativeRejections[0], { code: 4000, message: "synthetic invalid payload" });
  assert.deepEqual(
    nativeFrames.map((frame) => ({ cmd: frame.cmd, args: frame.args })),
    [
      { cmd: "SET_ORIENTATION_LOCK_STATE", args: primaryArgs },
      {
        cmd: "SET_ORIENTATION_LOCK_STATE",
        args: { lock_state: 1, picture_in_picture_lock_state: 2 },
      },
    ],
  );
  assert.equal(typeof nativeFrames[0].nonce, "string");
  assert.equal(typeof nativeFrames[1].nonce, "string");
  assert.notEqual(nativeFrames[0].nonce, nativeFrames[1].nonce);
  assert.equal(nativeSdk.pendingCommands.size, 0);
} finally {
  nativeSdk?.close(1000, "synthetic-finished");
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    delete globalThis.window;
  }
  if (originalDocument) {
    Object.defineProperty(globalThis, "document", originalDocument);
  } else {
    delete globalThis.document;
  }
}
assert.equal(nativeListeners.size, 0);
const nativePlainErrorFallback = {
  nativeSendCommand: true,
  plainErrorRejected: true,
  compatibilityFallback: true,
  primaryAndFallbackArgsExact: true,
  distinctNonces: true,
  commandFrames: nativeFrames.length,
  nativeRejections: nativeRejections.length,
  pendingCommandsAfterTerminal: nativeSdk.pendingCommands.size,
  listenersAfterClose: nativeListeners.size,
};
// Exercise all 13 generated command parsers using the official frozen JSON schemas.
const spec = JSON.parse(
  readFileSync(new URL("./discord-official-command-schema.json", import.meta.url), "utf8"),
);
const { schemaCommandFactory } = await load("utils/commandFactory");
function sample(schema) {
  if (schema == null) {
    return undefined;
  }
  if ("const" in schema) {
    return schema.const;
  }
  if (schema.enum) {
    return schema.enum[0];
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object") {
    return Object.fromEntries(
      (schema.required ?? []).map((k) => [k, sample(schema.properties[k])]),
    );
  }
  if (type === "array") {
    return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items));
  }
  if (type === "string") {
    return "x".repeat(Math.max(1, schema.minLength ?? 1));
  }
  if (type === "number" || type === "integer") {
    return schema.minimum ?? 0;
  }
  if (type === "boolean") {
    return false;
  }
  if (type === "null") {
    return null;
  }
  throw new Error(`Unsupported synthetic schema type ${type}`);
}
const generatedCommands = [];
for (const [cmd, definition] of Object.entries(spec)) {
  const request = sample(definition.request);
  const reply = sample(definition.response);
  same(await schemaCommandFactory(cmd)(async (p) => response(p.cmd, reply))(request), reply);
  await assert.rejects(
    schemaCommandFactory(cmd)(async () => response("WRONG_COMMAND", reply))(request),
  );
  checks++;
  await assert.rejects(
    schemaCommandFactory(cmd)(async (p) => response(p.cmd, "invalid-response"))(request),
  );
  checks++;
  generatedCommands.push(cmd);
}
let visits = 0;
const bounded = Message.shape.content
  .transform((x) => {
    visits++;
    return x;
  })
  .array()
  .max(1);
same(bounded.safeParse(["a", "b", "c"]).success, false);
same(visits, Number(expectedVisits));
console.log(
  JSON.stringify({
    format,
    checks,
    generatedCommands,
    nativePlainErrorFallback,
    threeElementsMaxOne: { rejected: true, elementVisits: visits },
    noExternalIO: true,
  }),
);
