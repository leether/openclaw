import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const [root, format = "mjs"] = process.argv.slice(2);
const load = (n) =>
  format === "cjs"
    ? Promise.resolve(require(resolve(root, "output", `${n}.cjs`)))
    : import(pathToFileURL(resolve(root, "output", `${n}.mjs`)));
const { Message } = await load("schema/common");
const { commandFactory, schemaCommandFactory } = await load("utils/commandFactory");
const { default: compatCommandFactory } = await load("utils/compatCommandFactory");
const envelope = { cmd: "AUTHORIZE", evt: null, nonce: "synthetic" };
const cases = [
  { name: "missing-data", reply: envelope, default: false, paths: [["data"]] },
  { name: "wrong-data", reply: { ...envelope, data: 5 }, default: false, paths: [["data"]] },
  {
    name: "missing-nested-content",
    reply: { ...envelope, data: {} },
    object: true,
    paths: [["data", "content"]],
  },
  {
    name: "wrong-nested-content",
    reply: { ...envelope, data: { content: 5 } },
    object: true,
    paths: [["data", "content"]],
  },
  {
    name: "wrong-command-and-data",
    reply: { ...envelope, cmd: "GET_CHANNEL", data: 5 },
    paths: [["cmd"], ["data"]],
  },
  { name: "missing-default", reply: envelope, default: true, value: "fallback" },
  {
    name: "undefined-default",
    reply: { ...envelope, data: undefined },
    default: true,
    value: "fallback",
  },
  { name: "invalid-default", reply: { ...envelope, data: 5 }, default: true, paths: [["data"]] },
];
const observations = [];
for (const factory of ["command", "compat"]) {
  for (const spec of cases) {
    const schema = spec.object
      ? Message.pick({ content: true })
      : spec.default
        ? Message.shape.content.default("fallback")
        : Message.shape.content;
    let calls = 0;
    const send = async () => {
      calls++;
      return spec.reply;
    };
    const fn =
      factory === "command"
        ? commandFactory(send, "AUTHORIZE", schema)
        : compatCommandFactory({
            sendCommand: send,
            cmd: "AUTHORIZE",
            response: schema,
            fallbackTransform: () => ({ legacy: true }),
          });
    let outcome;
    try {
      outcome = { accepted: true, value: await fn({}) };
    } catch (e) {
      outcome = {
        accepted: false,
        paths: e.issues?.map((x) => x.path),
        codes: e.issues?.map((x) => x.code),
        messages: e.issues?.map((x) => x.message),
      };
    }
    assert.equal(calls, 1);
    assert.equal(outcome.accepted, !spec.paths, spec.name);
    if (spec.paths) {
      assert.deepEqual(outcome.paths, spec.paths, spec.name);
    } else {
      assert.deepEqual(outcome.value, spec.value, spec.name);
    }
    observations.push({ factory, case: spec.name, calls, ...outcome });
  }
}
for (const data of [undefined, {}, { image_url: 5 }]) {
  let outcome;
  try {
    outcome = {
      accepted: true,
      value: await schemaCommandFactory("INITIATE_IMAGE_UPLOAD")(async () => ({
        cmd: "INITIATE_IMAGE_UPLOAD",
        evt: null,
        nonce: "n",
        data,
      }))(),
    };
  } catch (e) {
    outcome = {
      accepted: false,
      paths: e.issues?.map((x) => x.path),
      codes: e.issues?.map((x) => x.code),
      messages: e.issues?.map((x) => x.message),
    };
  }
  assert.equal(outcome.accepted, false);
  assert.deepEqual(outcome.paths, data === undefined ? [["data"]] : [["data", "image_url"]]);
  observations.push({
    factory: "generated",
    case:
      data === undefined
        ? "missing-data"
        : Object.keys(data).length
          ? "wrong-property"
          : "missing-property",
    ...outcome,
  });
}
console.log(
  JSON.stringify({ format, cases: observations.length, observations, noExternalIO: true }),
);
