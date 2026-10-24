import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// OpenClawTests is hosted by the real OpenClaw app (apps/ios/project.yml).
// Its startup reaches RootTabs, onboarding/settings, and NodeAppModel services.
// The voice group's typography suite also reads every app/Watch Swift source.
const sharedOwners = [
  /^apps\/ios\/Sources\//u,
  /^apps\/ios\/Resources\//u,
  /^apps\/shared\/OpenClawKit\/Sources\//u,
  /^apps\/swabble\/Sources\/SwabbleKit\//u,
  /^apps\/shared\/mermaid\//u,
  /^packages\/mermaid-renderer\//u,
  /^apps\/ios\/(?:project\.yml|[^/]+\.plist|[^/]+\.xcconfig|Config\/|Tests\/Info\.plist)/u,
  /^apps\/(?:shared\/OpenClawKit|swabble)\/Package\.(?:swift|resolved)$/u,
  /^apps\/macos\/Tests\/OpenClawIPCTests\/GatewayWebSocketTestSupport\.swift$/u,
  /^apps\/shared\/OpenClawKit\/Tests\/OpenClawKitTests\/(?:NativeGatewayWebSocketFixture|ChatMermaidRenderModelTests|ChatSelectableTextViewTests|ChatPasteboardTests)\.swift$/u,
];

const buildOwners = [
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/u,
  /^\.github\/(?:workflows\/ci\.yml|actions\/)/u,
  /^config\/swift(?:lint\.yml|format)$/u,
  /^scripts\/(?:ci-build-manifest\.mjs|ci-changed-scope\.mjs|prepare-apple-mermaid\.mjs|select-ios-simulator\.mjs)$/u,
  /^scripts\/ci-xcodebuild\.py$/u,
  /^scripts\/lib\/(?:ci-ios-smoke-plan\.mjs|swift-toolchain\.sh|(?:ios|mobile)-version\.ts|release-version\.mjs|version-script-args\.ts)$/u,
  /^scripts\/(?:check-swift-tools|format-swift|install-simslim|install-swift-tools|install-xcodegen|lint-swift|ios-configure-signing|ios-simulator-prepare|ios-team-id|ios-write-version-xcconfig)\.sh$/u,
  /^scripts\/(?:ios-write-swift-filelist\.m[jt]s|ios-version\.ts)$/u,
];

const voiceOwners = [
  /^apps\/ios\/WatchApp\/(?:Sources\/|Info\.plist$)/u,
  /^apps\/ios\/ActivityWidget\//u,
  /^apps\/ios\/Tests\/(?:TalkRealtimeVoiceSessionCleanupTests|TalkRealtimeConsultCancellationTests|TalkRealtimeTranscriptWriteQueueTests|TalkModeConfigParsingTests|ManagedDocumentEnvelopeTests|IOSMediaArtifactLoaderTests|OpenClawTypographyTests)\.swift$/u,
  /^apps\/ios\/Tests\/Fixtures\/managed-document-message\.json$/u,
];

const lifecycleOwners = [
  /^apps\/ios\/Tests\/(?:CloudflareAccessClientTests|CloudflareAccessTransferTests|CloudflareAccessSessionStoreTests|CloudflareAccessTestTokens|ChatTypingFocusTests|ChatSendHydrationTests)\.swift$/u,
];

/** Select simulator execution only; the app and test products still compile. */
export function resolveIosSimulatorTestSelection(
  changedPaths,
  { enabled = true, forceFull = false, fullReason = "full validation" } = {},
) {
  const selection = (mode, voice, lifecycle) => ({
    mode,
    voice: { selected: enabled && voice.length > 0, reasons: voice },
    lifecycle: { selected: enabled && lifecycle.length > 0, reasons: lifecycle },
  });
  if (!enabled) {
    return selection("not-selected", ["iOS job not selected"], ["iOS job not selected"]);
  }
  if (forceFull) {
    return selection("full", [fullReason], [fullReason]);
  }
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.some(
      (file) =>
        typeof file !== "string" ||
        !file ||
        file.startsWith("/") ||
        file.split("/").some((part) => part === "." || part === "..") ||
        /[\\\r\n\0]/u.test(file),
    )
  ) {
    return selection(
      "full",
      ["changed paths unavailable or invalid"],
      ["changed paths unavailable or invalid"],
    );
  }
  const voice = [];
  const lifecycle = [];
  for (const file of [...new Set(changedPaths)].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (buildOwners.some((pattern) => pattern.test(file))) {
      return selection("full", [`build/test input: ${file}`], [`build/test input: ${file}`]);
    }
    if (sharedOwners.some((pattern) => pattern.test(file))) {
      voice.push(`shared app/test owner: ${file}`);
      lifecycle.push(`shared app/test owner: ${file}`);
      continue;
    }
    if (voiceOwners.some((pattern) => pattern.test(file))) {
      voice.push(`voice/media/typography owner: ${file}`);
    }
    if (lifecycleOwners.some((pattern) => pattern.test(file))) {
      lifecycle.push(`Access/chat lifecycle owner: ${file}`);
    }
  }
  return selection("changed-owners", voice, lifecycle);
}

export function formatIosSimulatorSelectionSummary(selection) {
  const escape = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replace(/[\\`*_{}[\]()#+.!|]/gu, "\\$&")
      .replace(/[\r\n]/gu, " ");
  return (
    "### iOS simulator test selection\n\n" +
    `- Mode: ${escape(selection.mode)}.\n` +
    "- App and test-bundle compilation remain required when the iOS job is selected.\n\n" +
    "| Group | Run | Reasons |\n| --- | --- | --- |\n" +
    ["voice", "lifecycle"]
      .map((group) => {
        const { selected, reasons } = selection[group];
        const why = reasons.length ? reasons.map(escape).join("; ") : "No changed owner";
        return `| ${group} | ${selected ? "yes" : "no"} | ${why} |\n`;
      })
      .join("") +
    "\n"
  );
}

const repository = "leether/openclaw";
const deferredJobs = ["ios-screenshot-shard", "ios-screenshot-evidence"];
const deferredReason =
  "Explicit fork Linux-only scope: iOS screenshots are deferred and unverified because the screenshot runner billing allowance is unavailable. Prior red/unrun evidence is retained; no iOS proof is claimed.";

function readPullRequest(number, env) {
  assert.ok(env.OPENCLAW_CI_SCOPE_TOKEN, "Fork scope requires the workflow read token");
  try {
    return JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          `repos/${repository}/pulls/${number}`,
          "--jq",
          "{number,state,merged,head:.head.sha,branch:.head.ref,repository:.head.repo.full_name,baseRepository:.base.repo.full_name,base:.base.ref}",
        ],
        {
          encoding: "utf8",
          timeout: 10000,
          killSignal: "SIGKILL",
          maxBuffer: 8192,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...env,
            GH_TOKEN: env.OPENCLAW_CI_SCOPE_TOKEN,
            GH_HOST: "github.com",
            GH_PROMPT_DISABLED: "1",
          },
        },
      ),
    );
  } catch {
    throw new Error("Could not verify current fork pull-request identity");
  }
}

// The existing manifest owns selection. This adapter adds only the explicitly
// admitted two-job restriction; it never changes canonical-repository identity.
export function resolveForkLinuxScope({ env, compatibilityTarget }) {
  const optIn = env.OPENCLAW_CI_FORK_LINUX_ONLY ?? "false";
  assert.ok(["", "false", "true"].includes(optIn), "fork_linux_only must be a boolean");
  let identity = null;
  if (optIn === "true") {
    assert.equal(env.OPENCLAW_CI_REPOSITORY, repository, "Fork scope is repository-specific");
    assert.equal(env.GITHUB_REPOSITORY, repository, "Workflow repository differs");
    assert.equal(env.OPENCLAW_CI_EVENT_NAME, "workflow_dispatch");
    assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
    assert.equal(env.OPENCLAW_CI_RELEASE_GATE, "true", "Fork scope requires release_gate");
    assert.equal(env.OPENCLAW_CI_REQUESTED_RUNNER_BACKEND, "default");
    assert.equal(env.OPENCLAW_CI_REQUESTED_SHAPE, "default");
    assert.equal(env.OPENCLAW_CI_SHAPE, "default");
    assert.equal(env.OPENCLAW_CI_QUALIFICATION, "false");
    assert.equal(env.OPENCLAW_CI_RUNNER_PROFILE, "github");
    assert.equal(env.OPENCLAW_CI_NODE_RUNNER_BACKEND, "github");
    assert.equal(env.OPENCLAW_CI_RELEASE_SCOPE, "full");
    assert.equal(env.OPENCLAW_CI_VALIDATION_TIER, "full");
    assert.equal(compatibilityTarget, false);
    for (const name of [
      "HISTORICAL_TARGET_TAG",
      "RELEASE_CANDIDATE_REF",
      "TARGET_CONTEXT_REF",
      "DISPATCH_ID",
      "QUALIFICATION_BASELINES_JSON",
    ]) {
      assert.equal(env[`OPENCLAW_CI_${name}`] ?? "", "", `Fork scope cannot combine ${name}`);
    }
    for (const name of ["HISTORICAL_TARGET", "RELEASE_CANDIDATE_TARGET", "TARGET_CONTEXT_TARGET"]) {
      assert.equal(env[`OPENCLAW_CI_${name}`], "false", `Fork scope cannot combine ${name}`);
    }
    const sha = env.OPENCLAW_CI_TARGET_REF;
    assert.match(sha ?? "", /^[0-9a-f]{40}$/u, "Exact target SHA required");
    for (const name of [
      "OPENCLAW_CI_CHECKOUT_REVISION",
      "OPENCLAW_CI_WORKFLOW_REVISION",
      "GITHUB_SHA",
    ]) {
      assert.equal(env[name], sha, `Fork scope revision drift: ${name}`);
    }
    const number = env.OPENCLAW_CI_PULL_REQUEST_NUMBER;
    assert.match(number ?? "", /^[1-9][0-9]*$/u, "Exact pull request number required");
    assert.ok(Number.isSafeInteger(Number(number)));
    const pr = readPullRequest(number, env);
    assert.equal(pr.number, Number(number));
    assert.equal(pr.state, "open", "Fork pull request must remain open at selection");
    assert.equal(pr.merged, false);
    assert.equal(pr.repository, repository, "Fork scope requires a same-repository head");
    assert.equal(pr.baseRepository, repository, "Fork scope requires a same-repository base");
    assert.equal(pr.base, "main", "Fork pull request must target main");
    assert.equal(pr.head, sha, "Fork pull-request head moved");
    assert.equal(typeof pr.branch, "string");
    assert.ok(pr.branch.length > 0);
    assert.equal(env.GITHUB_REF, `refs/heads/${pr.branch}`, "Dispatch branch differs from PR head");
    identity = {
      repository,
      base: pr.base,
      pullRequest: pr.number,
      head: sha,
      workflow: sha,
      checkout: sha,
    };
  }
  const deferred = identity !== null;
  return {
    defer_ios_screenshots: deferred,
    ios_screenshot_coverage: deferred ? "deferred-unverified" : "unchanged",
    ios_screenshot_reason: deferred
      ? deferredReason
      : "Existing CI screenshot scope selection is unchanged.",
    ios_screenshot_scope: { identity, deferredJobs: deferred ? deferredJobs : [] },
  };
}
