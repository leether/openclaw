const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = JSON.parse(fs.readFileSync(process.env.NPM_CONSUMER_CONFIG, "utf8"));
const { download } = require(path.join(config.npmRoot, "node_modules/node-gyp/lib/download.js"));
async function main() {
  const response = await download({ version: "13.0.0", opts: {} }, config.url);
  assert.equal(response.status, 200);
  assert.equal(response.body.destroyed, false);
  let errorObserved = false;
  const closed = new Promise((resolve) => {
    response.body.once("error", (error) => {
      errorObserved = error.message === "synthetic-body-cancel";
    });
    response.body.once("close", resolve);
  });
  response.body.destroy(new Error("synthetic-body-cancel"));
  await closed;
  assert.equal(errorObserved, true);
  console.log(
    JSON.stringify({
      passed: true,
      headersReceived: true,
      bodyErrorObserved: true,
      bodyClosed: true,
      requestAbortSignalSupported: false,
    }),
  );
}
main().catch(() => {
  console.error("synthetic body consumer failed");
  process.exitCode = 1;
});
