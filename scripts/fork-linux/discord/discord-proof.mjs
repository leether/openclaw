import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { captureContract, validateContract, inspectInstallation, sha } from "./contracts.mjs";
import { runBounded } from "./processes.mjs";

const argv = process.argv.slice(2);
if (argv[0] === "capture") {
  try {
    assert.equal(argv.length, 3, "capture <sourceRoot> <out.json>");
    const contract = captureContract(argv[1]);
    fs.writeFileSync(argv[2], `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx" });
    console.log(
      JSON.stringify({
        passed: true,
        schema: contract.schema,
        contractSha256: sha(Buffer.from(JSON.stringify(contract))),
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        passed: false,
        schema: "discord-installed-contract-v1",
        failure: "capture-rejected",
        messageSha256: sha(Buffer.from(String(error?.message ?? error))),
      }),
    );
    process.exitCode = 1;
  }
} else if (argv.length !== 3) {
  console.log(
    JSON.stringify({
      schema: "discord-installed-proof-v1",
      passed: false,
      failure: "invalid-arguments",
    }),
  );
  process.exitCode = 1;
} else {
  const [pluginRoot, expected, output] = argv;
  const report = {
    schema: "discord-installed-proof-v1",
    passed: false,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    identity: null,
    artifactHashes: null,
    formats: {},
    assets: {},
    attempts: [],
    stage: "expected-contract",
    limits: {
      childV8MiB: 512,
      childWallMs: 30000,
      childOutputBytes: 262144,
      sequential: true,
      namespaceAndParentLimitsByCaller: true,
    },
  };
  try {
    const stat = fs.statSync(expected);
    assert.ok(stat.isDirectory() || (stat.isFile() && stat.size <= 1024 * 1024));
    const contract = stat.isDirectory()
      ? captureContract(expected)
      : validateContract(JSON.parse(fs.readFileSync(expected, "utf8")));
    report.stage = "installed-identity";
    const installed = inspectInstallation(pluginRoot, contract);
    report.identity = structuredClone(installed.identity);
    report.artifactHashes = {
      ...installed.artifactHashes,
      expectedContract: sha(Buffer.from(JSON.stringify(contract))),
    };
    const helper = path.join(import.meta.dirname, "public-sdk-entry.mjs");
    const evalSource = `import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {fileURLToPath,pathToFileURL} from 'node:url';
      const [root,sdkRoot,format,helper,kind]=process.argv.slice(1);const req=createRequire(path.join(root,'package.json'));
      const resolved=kind==='asset'?pathToFileURL(path.join(root,'dist/assets/embedded-app-sdk.mjs')).href:format==='cjs'?pathToFileURL(req.resolve('@discord/embedded-app-sdk')).href:import.meta.resolve('@discord/embedded-app-sdk');
      assert.ok(resolved.startsWith('file:'));const file=fs.realpathSync(fileURLToPath(resolved));const rel=path.relative(root,file);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
      if(kind!=='asset')assert.equal(file,path.join(sdkRoot,'output',format==='cjs'?'index.cjs':'index.mjs'));
      globalThis.__discordLoadQualifiedNamespace=async()=>kind==='asset'?await import(resolved):format==='cjs'?req('@discord/embedded-app-sdk'):await import('@discord/embedded-app-sdk');
      globalThis.__discordQualifiedEntry={kind,format,resolver:format==='cjs'?'node-require':'node-esm-import-conditions',relative:rel.split(path.sep).join('/')};
      process.argv=['node',helper,sdkRoot,format];await import(pathToFileURL(helper));`;
    for (const format of ["cjs", "mjs"]) {
      const name = format === "mjs" ? "esm" : "cjs";
      report.stage = `${name}-public-entry`;
      const publicSDK = await runBounded(
        [
          "--input-type=module",
          "-e",
          evalSource,
          installed.root,
          installed.sdkRoot,
          format,
          helper,
          "package",
        ],
        installed.root,
      );
      report.attempts.push({ stage: report.stage, result: publicSDK });
      assert.ok(publicSDK.passed, "native public SDK entry failed");
      report.stage = `${name}-compat`;
      const compat = await runBounded(
        [path.join(import.meta.dirname, "frozen/compat.mjs"), installed.sdkRoot, format, "0"],
        installed.root,
      );
      report.attempts.push({ stage: report.stage, result: compat });
      assert.ok(compat.passed);
      assert.equal(compat.proof.checks, 86);
      assert.equal(compat.proof.generatedCommands.length, 13);
      assert.equal(compat.proof.threeElementsMaxOne.elementVisits, 0);
      report.stage = `${name}-errors`;
      const errors = await runBounded(
        [path.join(import.meta.dirname, "frozen/error-contract.mjs"), installed.sdkRoot, format],
        installed.root,
      );
      report.attempts.push({ stage: report.stage, result: errors });
      assert.ok(errors.passed);
      assert.equal(errors.proof.cases, 19);
      report.formats[name] = {
        compatChecks: compat.proof.checks,
        generatedCommands: compat.proof.generatedCommands.length,
        errorCases: errors.proof.cases,
        publicSDK: publicSDK.proof,
        threeElementsMaxOne: compat.proof.threeElementsMaxOne,
        children: { publicSDK, compat, errors },
      };
      if (name === "esm") report.identity.esmEntryRelative = publicSDK.proof.entry.relative;
    }
    report.stage = "generated-sdk-asset";
    const asset = await runBounded(
      [
        "--input-type=module",
        "-e",
        evalSource,
        installed.root,
        installed.sdkRoot,
        "mjs",
        helper,
        "asset",
      ],
      installed.root,
    );
    report.attempts.push({ stage: report.stage, result: asset });
    assert.ok(asset.passed, "generated SDK asset communication failed");
    report.assets = {
      generatedSdk: asset,
      checkedPaths: Object.keys(installed.artifactHashes.staticAssets),
    };
    report.stage = "post-execution-identity";
    const after = inspectInstallation(pluginRoot, contract);
    assert.deepEqual(after.identity, installed.identity);
    assert.deepEqual(after.artifactHashes, installed.artifactHashes);
    report.identityReverifiedAfterExecution = true;
    report.stage = "passed";
    report.passed = true;
  } catch (error) {
    report.failure = {
      kind: error?.name === "AssertionError" ? "contract-rejected" : "qualification-error",
      messageSha256: sha(Buffer.from(String(error?.message ?? error))),
    };
  }
  // Report only public metadata, relative identities, synthetic fixtures and hashes.
  try {
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(
      JSON.stringify({
        schema: report.schema,
        passed: report.passed,
        stage: report.stage,
        node: report.node,
      }),
    );
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.log(
      JSON.stringify({
        schema: report.schema,
        passed: false,
        failure: "report-write-rejected",
        messageSha256: sha(Buffer.from(String(error?.message ?? error))),
      }),
    );
    process.exitCode = 1;
  }
}
