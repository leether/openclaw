import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inspect, identityOnly, hashesOnly, sha } from "./identity.mjs";
import { runBounded } from "./processes.mjs";
const args = process.argv.slice(2);
const report = {
  schema: "msal-consumer-installed-proof-v1",
  passed: false,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  stage: "arguments",
  cells: [],
  noLiveAzureAuthorizationClaim: true,
};
let output;
try {
  if (args[0] === "capture") {
    assert.equal(args.length, 3);
    const source = fs.realpathSync(args[1]);
    output = args[2];
    const rows = inspect(path.join(source, "extensions/msteams"), source);
    Object.assign(report, {
      schema: "msal-consumer-contract-v1",
      passed: true,
      parents: hashesOnly(rows),
      sourcePaths: identityOnly(rows),
      stage: "capture",
    });
  } else {
    assert.equal(args.length, 3);
    const [root, contractFile, out] = args;
    output = out;
    const raw = fs.readFileSync(contractFile);
    assert.ok(raw.length <= 65536);
    const contract = JSON.parse(raw);
    assert.equal(contract.schema, "msal-consumer-contract-v1");
    assert.equal(contract.passed, true);
    const before = inspect(root);
    assert.deepEqual(hashesOnly(before), contract.parents);
    report.identity = identityOnly(before);
    report.contractSha256 = sha(raw);
    for (const scenario of [
      "azure-secret",
      "azure-certificate",
      "azure-managed",
      "teams-secret",
      "teams-certificate-provider",
      "teams-managed-user",
      "teams-managed-system",
    ]) {
      report.stage = scenario;
      const result = await runBounded(
        [path.join(import.meta.dirname, "scenario.mjs"), fs.realpathSync(root), scenario],
        fs.realpathSync(root),
      );
      report.cells.push({ scenario, result });
      assert.ok(result.passed);
      assert.equal(result.proof.passed, true);
      assert.equal(result.proof.noOutbound, true);
      assert.equal(result.proof.serverListenCalls, 0);
    }
    assert.deepEqual(identityOnly(inspect(root)), identityOnly(before));
    report.identityReverifiedAfterExecution = true;
    report.stage = "passed";
    report.passed = true;
  }
} catch (error) {
  report.failure = {
    name: error?.name ?? "Error",
    messageSha256: sha(Buffer.from(String(error?.message ?? error))),
  };
}
try {
  assert.equal(typeof output, "string");
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
} catch (error) {
  report.passed = false;
  report.outputFailureSha256 = sha(Buffer.from(String(error?.message ?? error)));
}
console.log(JSON.stringify({ schema: report.schema, passed: report.passed, stage: report.stage }));
process.exitCode = report.passed ? 0 : 1;
