import nativeAssert from "node:assert/strict";
let checks = 0;
const assert = new Proxy(nativeAssert, {
  get(target, key) {
    const value = target[key];
    return typeof value === "function"
      ? (...args) => {
          checks++;
          return value.apply(target, args);
        }
      : value;
  },
});
const [, format = "mjs"] = process.argv.slice(2);
const outbox = [];
const listeners = new Set();
globalThis.window = {
  location: {
    origin: "https://fixture.invalid",
    search: "?frame_id=f&instance_id=i&platform=desktop&channel_id=c",
  },
  parent: { postMessage: (tuple) => outbox.push(tuple) },
  addEventListener: (kind, fn) => {
    assert.equal(kind, "message");
    listeners.add(fn);
  },
  removeEventListener: (kind, fn) => listeners.delete(fn),
};
globalThis.document = { referrer: "https://discord.com" };
const load = await globalThis.discordLoadQualifiedNamespace();
assert.ok(
  load && typeof load.DiscordSDK === "function",
  "qualified native entry namespace required",
);
const { DiscordSDK } = load;
const sdk = new DiscordSDK("synthetic", { disableConsoleLogOverride: true });
const frame = (payload, origin = "https://discord.com") => {
  for (const fn of listeners) {
    fn({ data: [1, payload], origin });
  }
};
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Synthetic SDK settlement exceeded 1s")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
assert.equal(outbox.length, 1);
assert.equal(outbox[0][0], 0);
frame({
  cmd: "DISPATCH",
  evt: "READY",
  nonce: null,
  data: { v: 1, config: { api_endpoint: "loopback.invalid", environment: "synthetic" } },
});
await bounded(sdk.ready());
let settled = 0;
const authPromise = sdk.commands.authenticate({ access_token: "synthetic" }).then((v) => {
  settled++;
  return v;
});
const authCall = outbox.at(-1)[1];
assert.equal(authCall.cmd, "AUTHENTICATE");
const authData = {
  access_token: "synthetic",
  user: { id: "1", username: "u", discriminator: "0001", public_flags: 0 },
  scopes: ["identify", "new.scope"],
  expires: "future",
  application: { id: "app", name: "fixture", description: "" },
};
const good = { cmd: "AUTHENTICATE", evt: null, nonce: authCall.nonce, data: authData };
frame({ ...good, nonce: "wrong-nonce" });
frame(good, "https://untrusted.invalid");
await Promise.resolve();
assert.equal(settled, 0);
const errorLogs = [];
const oldError = console.error;
console.error = (...args) => errorLogs.push(args.length);
try {
  frame({ ...good, data: {} });
} finally {
  console.error = oldError;
}
await Promise.resolve();
assert.equal(settled, 0);
assert.equal(errorLogs.length, 2);
frame(good);
const authenticated = await bounded(authPromise);
assert.deepEqual(authenticated.scopes, ["identify", -1]);
assert.equal(settled, 1);
assert.equal(sdk.pendingCommands.size, 0);
frame(good);
await Promise.resolve();
assert.equal(settled, 1);
const failed = sdk.commands.getChannel({ channel_id: "c" });
const failureCall = outbox.at(-1)[1];
const rejection = assert.rejects(
  failed,
  (error) => error.code === 4000 && error.message === "synthetic",
);
frame({
  cmd: "GET_CHANNEL",
  evt: "ERROR",
  nonce: failureCall.nonce,
  data: { code: 4000, message: "synthetic" },
});
await bounded(rejection);
assert.equal(sdk.pendingCommands.size, 0);
const opened = sdk.commands.openExternalLink({ url: "https://invalid.example" });
const openCall = outbox.at(-1)[1];
frame({
  cmd: "OPEN_EXTERNAL_LINK",
  evt: null,
  nonce: openCall.nonce,
  data: { opened: "future-value" },
});
assert.deepEqual(await bounded(opened), { opened: null });
assert.equal(sdk.pendingCommands.size, 0);
assert.equal(outbox.length, 4);
sdk.close(1000, "synthetic-finished");
assert.equal(outbox.length, 5);
assert.equal(listeners.size, 0);
console.log(
  JSON.stringify({
    format,
    checks,
    commands: 3,
    entry: globalThis.discordQualifiedEntry,
    handshake: true,
    ready: true,
    exactNonceSettlement: true,
    foreignOriginIgnored: true,
    malformedResponseRemainsPending: true,
    duplicateResponseNoSecondSettlement: true,
    errorRejected: true,
    fallbackPreserved: true,
    threeCommandsNoRetries: true,
    pendingCommandsAfterTerminal: 0,
    listenersAfterClose: 0,
    noExternalIO: true,
  }),
);
