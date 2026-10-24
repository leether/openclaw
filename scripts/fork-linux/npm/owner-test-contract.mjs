import assert from "node:assert/strict";

export const OWNER_TEST_FILES = [
  "test/scripts/package-bundled-npm.test.ts",
  "test/scripts/package-npm-runtime.test.ts",
  "test/scripts/generate-npm-package-lock.test.ts",
  "test/scripts/installed-npm-proof.test.ts",
  "test/scripts/check-openclaw-package-tarball.test.ts",
];
export const LIFECYCLE_TEST_FILE =
  "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts";
export const OFFICIAL_FIXTURE_TESTS = {
  "test/scripts/package-bundled-npm.test.ts":
    "derives deterministically, preserves all unrelated files, and rejects a changed final tree",
  "test/scripts/generate-npm-package-lock.test.ts":
    "keeps official npm input identity distinct from its exact derived lock identity",
};
const WINDOWS_ONLY = new Set([
  "runs npm through the toolchain-local runner on Windows",
  "runs pnpm.cmd through the portable runner on Windows",
  "kills pnpm.cmd descendants when the package command times out",
]);

export function verifyOwnerTests(report, expectedFiles) {
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numFailedTestSuites, 0);
  if (report.numRuntimeErrorTestSuites !== undefined) {
    assert.equal(report.numRuntimeErrorTestSuites, 0);
  }
  assert.ok(Array.isArray(report.testResults));
  assert.equal(report.testResults.length, expectedFiles.length);
  const results = [];
  let count = 0;
  let skipped = 0;
  for (const file of expectedFiles) {
    const matching = report.testResults.filter(
      (suite) =>
        typeof suite.name === "string" && (suite.name === file || suite.name.endsWith(`/${file}`)),
    );
    assert.equal(matching.length, 1, `missing or duplicate test file: ${file}`);
    const suite = matching[0];
    assert.equal(suite.status, "passed");
    assert.ok(Array.isArray(suite.assertionResults) && suite.assertionResults.length > 0);
    const pendingTitles = [];
    let passed = 0;
    for (const assertion of suite.assertionResults) {
      assert.equal(typeof assertion.title, "string");
      assert.ok(Array.isArray(assertion.failureMessages) && assertion.failureMessages.length === 0);
      if (assertion.status === "passed") {
        passed++;
      } else {
        assert.ok(["pending", "skipped"].includes(assertion.status));
        assert.equal(file, LIFECYCLE_TEST_FILE, "in-scope owner tests may not be skipped");
        assert.ok(WINDOWS_ONLY.has(assertion.title), "unknown skipped lifecycle test");
        pendingTitles.push(assertion.title);
      }
    }
    assert.ok(passed > 0);
    if (OFFICIAL_FIXTURE_TESTS[file]) {
      const selected = suite.assertionResults.filter(
        (item) => item.title === OFFICIAL_FIXTURE_TESTS[file],
      );
      assert.equal(selected.length, 1);
      assert.equal(selected[0].status, "passed", "official-input fixture did not execute");
    }
    count += passed;
    skipped += pendingTitles.length;
    results.push({ file, passed, skipped: pendingTitles });
  }
  assert.equal(report.numPassedTests, count);
  assert.equal(report.numPendingTests, skipped);
  assert.equal(report.numTotalTests, count + skipped);
  return { passed: true, assertionsPassed: count, platformSkipped: skipped, files: results };
}
