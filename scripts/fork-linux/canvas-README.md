# Actual installed Canvas qualification helper

Prepared locally; actual full Linux execution remains pending. No product/bootstrap, frozen A2UI candidate, source lock, or ops script was changed. Integrator copies the four runtime modules together into `scripts/fork-linux/`; the small test file is optional at that location.

## Commands

```sh
node canvas-proof.mjs capture /absolute/source /absolute/new-capture.json
node canvas-proof.mjs runtime /absolute/installed/node_modules/openclaw /absolute/capture.json /absolute/new-runtime.json
node canvas-proof.mjs browser /absolute/installed/node_modules/openclaw /absolute/restored/node_modules/openclaw /absolute/source /absolute/capture.json /absolute/new-proof-dir
```

Each command requires Node 24.22.0 or 24.22.1. Capture runs once after the successful canonical full build, before packaging. Runtime runs against each installed/restored prefix for both Node versions. Browser runs once (normally Node 24.22.1), consuming the two actual bundles from each prefix: four combinations, twenty steps. It never rebuilds or substitutes a source/candidate bundle during installed proof. Output files and browser proof directory must not exist.

Capture invokes the source owner's `scripts/fork-linux/patched-consumer-contract.mjs` verifier, preserving the normal pnpm input/lock/patch/tree contract. It filters the verified two A2UI inputs for its report, checks the canonical Canvas build stamp against current tracked build inputs using the bundler's own exported discovery/order functions, and proves copied dist bundles equal the stamped source bundles. It then imports the real built Canvas plugin, registers its host-enabled/disabled surfaces and calls the real registered board-widget JSONL validation and document composition. Node `registerHooks` records the core dist files actually resolved/loaded by those named cases. No independent A2UI npm node is required in the installed package: tsdown may inline it.

Runtime verifies those exact built bundle/closure hashes **before importing**, exercises the actual installed Canvas entry and requires the observed core closure set/hashes to match capture. It tests registration twice, accepts v0.8/v0.9 JSONL, rejects nine malformed/dialect/extra-field cases, and composes each dialect with the expected encoded boot data and correct bundle. It does not invoke registered tool/CLI/node callbacks. External loaded dependency counts are reported; the normal installed dependency graph and audit remain the owner qualifier's responsibility. This closure covers named cases, not every lazy Canvas feature.

## Browser prerequisites and resource ownership

- Source workspace's existing `ui/package.json` resolution must provide Playwright with `routeWebSocket` support. This matches the UI dependency owner, not an unrelated root dependency instance.
- Its `chromium.executablePath()` must already exist. The helper never downloads a browser. The integrator can use the already governed browser preparation entry before entering the offline namespace.
- Browser runs as the non-root runner inside the outer qualifier's loopback-only OS namespace. Native Chromium sandbox stays enabled. Fresh owned profile, blocked service workers, exact loopback HTTP routing and blocked WebSockets are additional application controls; these are not claimed to establish OS isolation.
- The browser parent uses the existing source `runManagedCommand` owner with `memoryLimitBytes=1073741824`, `MemorySwapMax=0`, `requireProcessTreeExit=true` and 512 MiB Node V8. A unique systemd user scope contains the worker plus all Chromium descendants. The source setup must already provide a working cgroup-v2 user manager and XDG_RUNTIME_DIR. Missing kernel containment is a failure, never an env-flag assertion. The managed worker timeout is 20 seconds, reserving teardown inside the approved 60-second outer wall; successful total elapsed must stay below 60 seconds. The outer qualifier must retain its 60-second emergency wall and loopback-only namespace. The helper starts one Chromium and executes four consumers serially.
- Before and after the worker, kernel memory.max/swap.max, local max/oom/oom_kill counters (plus oom_group_kill when exposed by the kernel), peak, cgroup path/device/inode are read and verified. Any limit hit/OOM/peak above 1 GiB fails. The parent binds the exact onMemoryScope unit and only publishes the final report after the managed owner has joined all work and an independent systemctl/cgroup read confirms the scope empty or removed. Child evidence is named `unqualified-browser.json`; its early passed flag is never a final acceptance. The final report sets `cleanup.processTreeVerifiedEmpty=true`.
- Browser's explicit V8 limit is 512 MiB. The outer managed-worker log separately has a 1 MiB aggregate cap; it does not replace the Chromium cap. Its combined stdout/stderr cap is 32 KiB; a sticky flag forces final failure even when excess arrives after the last case. Each DOM wait is bounded. Screenshots and results remain in the new proof directory. No user profile, login, private source, provider, model, paired device, or production host is involved.

## Report schema (version 1)

All reports carry `schemaVersion`, `phase`, `passed`, exact `node`, `platform`, `arch`, `artifactHashes`, and `caseCounts` when a phase completes successfully. Failed capture/runtime writes `passed:false` and a bounded error to its new output path; failed browser does not produce a passing final report. CLI exit is nonzero on any failed assertion.

Capture:

- `patchedInputs`: two verified A2UI package identity/tree records, resolved Zod 4.6.6.
- `artifactHashes.sourceLock`, `.consumerContract`, `.sourceInputs` (relative path to SHA256/bytes), `.bundleBuildInputHash`.
- `artifactHashes.bundles`: `v08` / `v09`, each `{path,sha256,bytes}` using canonical dist-relative paths.
- `artifactHashes.runtimeClosure`: each actual resolved/loaded core dist-relative file mapped to `{sha256,bytes}`.
- `caseCounts`: exactly `{registration:2,jsonlAccepted:2,jsonlRejected:9,composition:2}`.
- `assertions`, `closureScope`, `runtimeClosureBytes`, `externalModuleCount`.

Runtime has the same bundle/closure and case-count forms, plus `captureSha256`. Aggregate checks should require exact counts, `passed:true`, exact Node version, capture digest, bundle and closure equality. A passing hash scan alone is insufficient: the runtime phase includes actual consumer execution.

Browser final report is `proofDir/report.json`:

- `captureSha256`, `artifactHashes.installed` / `.restored`, each the two fixed bundle records.
- `caseCounts`: exactly `{combinations:4,passed:4,steps:20}`.
- `results`: four rows, lanes `installed` and `restored`, versions `v08` and `v09`, matching `bundleSha256`, `status:'passed'`, and respectively 4 or 6 named steps.
- `browser`: actual version, Playwright version and default executable.
- `externalRequestsBlocked:[]`, `webSocketsBlocked:[]`, `pageErrors:[]`, twelve synthetic GET requests; `cleanup.cdpClosed`, `.serverClosed`, `.browserLeaderExited` true; no cleanup errors.
- Final `containment.verified=true`, `memoryLimitBytes=1073741824`, `memorySwapMax=0`, zero max/OOM/OOM-kill events (and zero optional group-OOM events), `peakBytes<=1073741824`, `empty=true`, `elapsedMs<60000` and `cleanup.processTreeVerifiedEmpty=true` are mandatory. `workerContainment.before` and `.after` retain the exact cgroup path/device/inode, limits, local counters and peak; the path must end with the unique `containment.unit`. `containment.finalUnitState` and `.systemctlStatus` record the explicit inactive removed/loaded result; errors, signals, duplicate/missing fields and other statuses fail closed. `browserOutput` requires `{bytes<=32768,limitBytes:32768,limitExceeded:false}`. Final assertions include `owned-cgroup-limit-and-extinction-verified`. `evidence/*result.json` is the detailed browser subproof; only final `report.json` includes capture-bound installed/restored artifact hashes.

## Local verification and limits

`local-static-proof-final.json` records four `node --check` runs and nineteen pure negative/binding tests, all passed on Node 26.4/macOS. No actual built Gateway/Canvas module, browser, installation, VM, Linux artifact, or network was run in this preparation. The old formal Canvas browser proof is provenance for the reused fixture only; it does not qualify the new final Linux installation.

No new dependency, browser download, full build or large archive was created. Current local disk is below 6 GiB; preparation is small source and JSON evidence only. Optional Markdown rendering, arbitrary external custom schemas and real paired-device behavior are outside these named cases.

The unchanged owner worst-case budget is explicitly reserved: less than 2 seconds of preparation (otherwise refuse before scope creation), up to 5 seconds initial systemctl check, 20 seconds worker, up to 7 seconds child/group join including the owner's default signal-exit grace, up to 20.05 seconds scope kill/stop/readback loop, and 3 seconds independent final readback: under 57.1 seconds of configured allowances. The existing 60-second outer emergency wall remains mandatory; scheduler or uninterruptible kernel I/O is not claimed to have a mathematically strict latency bound. Actual execution, cleanup and resource receipts remain pending Linux CI.
