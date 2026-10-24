import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveForkLinuxScope } from "../../scripts/lib/ci-ios-smoke-plan.mjs";
import { evaluateWorkflowExpression, readCiWorkflow } from "./ci-workflow.test-support.js";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const repository = "leether/openclaw";
const screenshotJobs = ["ios-screenshot-shard", "ios-screenshot-evidence"];
const pr = {
  number: 17,
  state: "open",
  merged: false,
  head: sha,
  branch: "leether/candidate",
  repository,
  baseRepository: repository,
  base: "main",
};
let fixtureRoot: string;
beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "openclaw-fork-scope-"));
  const gh = path.join(fixtureRoot, "gh");
  // Exercise the actual read boundary without network access or credentials.
  writeFileSync(
    gh,
    `#!/bin/sh\n[ "$1" = api ] && [ "$2" = --hostname ] && [ "$3" = github.com ] && [ "$4" = repos/leether/openclaw/pulls/17 ] && [ "$5" = --jq ] || exit 64\n[ "$GH_TOKEN" = synthetic-read-token ] || exit 65\n[ "\${SCOPE_TEST_API_FAIL:-false}" != true ] || exit 1\nprintf '%s' "$SCOPE_TEST_PR"\n`,
  );
  chmodSync(gh, 0o700);
});
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
function input(overrides: Record<string, string | undefined> = {}) {
  return {
    PATH: fixtureRoot,
    OPENCLAW_CI_SCOPE_TOKEN: "synthetic-read-token",
    SCOPE_TEST_PR: JSON.stringify(pr),
    OPENCLAW_CI_FORK_LINUX_ONLY: "true",
    OPENCLAW_CI_REPOSITORY: repository,
    GITHUB_REPOSITORY: repository,
    OPENCLAW_CI_EVENT_NAME: "workflow_dispatch",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    OPENCLAW_CI_RELEASE_GATE: "true",
    OPENCLAW_CI_REQUESTED_RUNNER_BACKEND: "default",
    OPENCLAW_CI_REQUESTED_SHAPE: "default",
    OPENCLAW_CI_SHAPE: "default",
    OPENCLAW_CI_QUALIFICATION: "false",
    OPENCLAW_CI_RUNNER_PROFILE: "github",
    OPENCLAW_CI_NODE_RUNNER_BACKEND: "github",
    OPENCLAW_CI_RELEASE_SCOPE: "full",
    OPENCLAW_CI_VALIDATION_TIER: "full",
    OPENCLAW_CI_HISTORICAL_TARGET: "false",
    OPENCLAW_CI_RELEASE_CANDIDATE_TARGET: "false",
    OPENCLAW_CI_TARGET_CONTEXT_TARGET: "false",
    OPENCLAW_CI_TARGET_REF: sha,
    OPENCLAW_CI_CHECKOUT_REVISION: sha,
    OPENCLAW_CI_WORKFLOW_REVISION: sha,
    GITHUB_SHA: sha,
    GITHUB_REF: `refs/heads/${pr.branch}`,
    OPENCLAW_CI_PULL_REQUEST_NUMBER: "17",
    ...overrides,
  };
}
function resolve(overrides: Record<string, string | undefined> = {}, compatibilityTarget = false) {
  return resolveForkLinuxScope({ env: input(overrides), compatibilityTarget });
}

describe("explicit fork Linux screenshot deferral admission", () => {
  it("returns an exact two-job unverified receipt for the current open same-repository head", () => {
    const result = resolve();
    expect(result.defer_ios_screenshots).toBe(true);
    expect(result.ios_screenshot_coverage).toBe("deferred-unverified");
    expect(result.ios_screenshot_reason).toContain("no iOS proof is claimed");
    expect(result.ios_screenshot_scope).toEqual({
      identity: {
        repository,
        base: "main",
        pullRequest: 17,
        head: sha,
        workflow: sha,
        checkout: sha,
      },
      deferredJobs: screenshotJobs,
    });
  });
  it.each([undefined, "", "false"])(
    "leaves ordinary scope unchanged with opt-in %s and never reads the PR",
    (flag) => {
      const env: Record<string, string | undefined> = { OPENCLAW_CI_FORK_LINUX_ONLY: flag };
      expect(resolveForkLinuxScope({ env, compatibilityTarget: true })).toEqual({
        defer_ios_screenshots: false,
        ios_screenshot_coverage: "unchanged",
        ios_screenshot_reason: "Existing CI screenshot scope selection is unchanged.",
        ios_screenshot_scope: { identity: null, deferredJobs: [] },
      });
    },
  );
  it.each([
    ["OPENCLAW_CI_FORK_LINUX_ONLY", "TRUE", "fork_linux_only"],
    ["OPENCLAW_CI_REPOSITORY", "openclaw/openclaw", "repository-specific"],
    ["OPENCLAW_CI_REPOSITORY", "other/openclaw", "repository-specific"],
    ["GITHUB_REPOSITORY", "other/openclaw", "Workflow repository"],
    ["OPENCLAW_CI_EVENT_NAME", "pull_request", "pull_request"],
    ["GITHUB_EVENT_NAME", "push", "push"],
    ["OPENCLAW_CI_RELEASE_GATE", "false", "requires release_gate"],
    ["OPENCLAW_CI_REQUESTED_RUNNER_BACKEND", "hybrid", "hybrid"],
    ["OPENCLAW_CI_REQUESTED_RUNNER_BACKEND", "runson", "runson"],
    ["OPENCLAW_CI_REQUESTED_SHAPE", "main", "main"],
    ["OPENCLAW_CI_SHAPE", "main", "main"],
    ["OPENCLAW_CI_QUALIFICATION", "true", "true"],
    ["OPENCLAW_CI_RUNNER_PROFILE", "hybrid", "hybrid"],
    ["OPENCLAW_CI_NODE_RUNNER_BACKEND", "runson", "runson"],
    ["OPENCLAW_CI_RELEASE_SCOPE", "npm-beta", "npm-beta"],
    ["OPENCLAW_CI_RELEASE_SCOPE", "npm-stable", "npm-stable"],
    ["OPENCLAW_CI_VALIDATION_TIER", "main", "main"],
    ...[
      "HISTORICAL_TARGET_TAG",
      "RELEASE_CANDIDATE_REF",
      "TARGET_CONTEXT_REF",
      "DISPATCH_ID",
      "QUALIFICATION_BASELINES_JSON",
    ].map((field) => [`OPENCLAW_CI_${field}`, "present", `cannot combine ${field}`]),
    ...["HISTORICAL_TARGET", "RELEASE_CANDIDATE_TARGET", "TARGET_CONTEXT_TARGET"].map((field) => [
      `OPENCLAW_CI_${field}`,
      "true",
      `cannot combine ${field}`,
    ]),
    ["OPENCLAW_CI_TARGET_REF", "main", "Exact target SHA"],
    ...["OPENCLAW_CI_CHECKOUT_REVISION", "OPENCLAW_CI_WORKFLOW_REVISION", "GITHUB_SHA"].map(
      (field) => [field, otherSha, `revision drift: ${field}`],
    ),
    ["OPENCLAW_CI_PULL_REQUEST_NUMBER", "0", "Exact pull request"],
    ["OPENCLAW_CI_PULL_REQUEST_NUMBER", "17;echo bad", "Exact pull request"],
    ["GITHUB_REF", "refs/heads/other", "Dispatch branch differs"],
  ])("rejects %s=%s at its own guard", (field, value, reason) => {
    expect(() => resolve({ [field]: value })).toThrow(reason);
  });
  it.each([
    ["state", "closed", "must remain open"],
    ["merged", true, "true"],
    ["repository", "other/openclaw", "same-repository head"],
    ["baseRepository", "openclaw/openclaw", "same-repository base"],
    ["base", "release/other", "must target main"],
    ["head", otherSha, "head moved"],
    ["number", 18, "18"],
    ["branch", "other", "Dispatch branch"],
  ])("rejects changed PR %s", (field, value, reason) => {
    expect(() => resolve({ SCOPE_TEST_PR: JSON.stringify({ ...pr, [field]: value }) })).toThrow(
      reason,
    );
  });
  it("rejects compatibility targets independently", () => {
    expect(() => resolve({}, true)).toThrow();
  });
  it.each([{ SCOPE_TEST_API_FAIL: "true" }, { SCOPE_TEST_PR: "invalid-json" }])(
    "fails closed on unavailable metadata %j",
    (override) => {
      expect(() => resolve(override)).toThrow(
        "Could not verify current fork pull-request identity",
      );
    },
  );
});

const workflow = readCiWorkflow();
const gate = workflow.jobs["ci-gate"].steps.find(
  (step: { name?: string }) => step.name === "Verify selected CI lanes",
);
function context(defer: boolean) {
  const outputs: Record<string, string> = Object.fromEntries(
    [...gate.env.JOB_RESULTS.matchAll(/needs\.preflight\.outputs\.([\w_]+)/gu)].map((match) => [
      match[1],
      "true",
    ]),
  );
  Object.assign(outputs, {
    defer_ios_screenshots: String(defer),
    release_scope: "full",
    validation_tier: "full",
    compatibility_target: "false",
    runner_profile: "github",
    node_runner_backend: "github",
    ci_qualification: "false",
    frozen_target: "false",
    narrow_check_paths_json: "",
    checkout_revision: sha,
    disable_fail_fast: "false",
  });
  return {
    eventName: "workflow_dispatch" as const,
    repository,
    runAttempt: 1,
    sha,
    releaseGate: true,
    targetRef: sha,
    preflightOutputs: outputs,
    additionalNeeds: Object.fromEntries(
      Object.keys(workflow.jobs).map((name) => [
        name,
        {
          result: "success" as const,
          outputs: {
            run_lint_core: "true",
            run_lint_extensions: "true",
            run_changed_core_type_stripes: "true",
          },
        },
      ]),
    ),
  };
}
function rows(defer: boolean) {
  const ctx = context(defer);
  const jobResults = gate.env.JOB_RESULTS;
  if (typeof jobResults !== "string") throw new Error("JOB_RESULTS must be a string");
  return jobResults
    .trim()
    .split("\n")
    .map((line: string) => {
      const rendered = line.replace(/\$\{\{[^}]+\}\}/gu, (expression: string) =>
        String(evaluateWorkflowExpression(expression, ctx)),
      );
      const match = rendered.match(/^([^=]+)=([^|]+)\|(true|false)$/u);
      if (!match) {
        throw new Error(`Invalid rendered gate row: ${rendered}`);
      }
      const [, name, result, selected] = match;
      if (!name || !result) throw new Error("Missing gate row identity");
      return { name, result, selected: selected === "true" };
    });
}
function runGate(changes: Record<string, string> = {}) {
  const inputRows = rows(true).map(
    (row) =>
      `${row.name}=${changes[row.name] ?? (row.selected ? "success" : "skipped")}|${row.selected}`,
  );
  return spawnSync("bash", ["--noprofile", "--norc", "-c", gate.run], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 32768,
    env: {
      PATH: process.env.PATH,
      JOB_RESULTS: inputRows.join("\n"),
      RELEASE_FAST_LANE: "false",
      ALLOW_KNOWN_MAIN_RED: "false",
      ALLOW_COALESCED_IOS: "false",
    },
  });
}

describe("real workflow screenshot selection and aggregate gate", () => {
  it("changes only the two screenshot selections while job conditions and gate agree", () => {
    const normal = rows(false);
    const scoped = rows(true);
    expect(
      scoped
        .filter((row, index) => row.selected !== normal[index]?.selected)
        .map((row) => row.name),
    ).toEqual(screenshotJobs);
    for (const name of screenshotJobs) {
      expect(evaluateWorkflowExpression(workflow.jobs[name].if, context(false))).toBe(true);
      expect(evaluateWorkflowExpression(workflow.jobs[name].if, context(true))).toBe(false);
      expect(scoped.find((row) => row.name === name)?.selected).toBe(false);
    }
    expect(runGate().status).toBe(0);
  });
  it.each([
    "security-fast",
    "check-shard",
    "checks-node-core-test-nondist-shard",
    "checks-ui",
    "checks-ui-e2e-real-gateway",
    "build-artifacts",
  ])("keeps %s required for success, including cancellation and unexpected skip", (name) => {
    expect(rows(true).find((row) => row.name === name)?.selected).toBe(true);
    for (const result of ["failure", "cancelled", "skipped"]) {
      const child = runGate({ [name]: result });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stdout).toContain(`${name} finished with ${result}`);
    }
  });
  it.each(screenshotJobs)("does not launder an actual %s failure into success", (name) => {
    expect(runGate({ [name]: "failure" }).status).toBe(1);
  });
  it("does not emit the full cross-platform workflow-revision receipt", () => {
    const receipt = workflow.jobs["ci-gate"].steps.find(
      (step: { name?: string }) => step.name === "Confirm validated workflow revision",
    );
    expect(evaluateWorkflowExpression(`\${{ ${receipt.if} }}`, context(true))).toBe(false);
  });
});
