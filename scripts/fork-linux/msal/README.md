# MSAL parent-consumer installation proof

This is a synthetic authentication compatibility check, not an Azure tenant authorization test. It imports the real installed Azure Identity 4.13.3 and Teams Apps 2.1.0 parents and their own resolved MSAL Node 7.1.0. It never replaces MSAL classes or methods. MSAL's official CJS entry and package manifest bytes are pinned to the already verified official tarball; the common dependency must resolve to 16.14.2.

## CLI and integration

```sh
node msal-proof.mjs capture /absolute/frozen/source /absolute/artifacts/msal-contract.json
node msal-proof.mjs /absolute/installed/node_modules/@openclaw/msteams /absolute/artifacts/msal-contract.json /absolute/artifacts/msal-installed.json
```

The capture command requires the two actual parents in the source dependency graph to resolve to MSAL 7.1.0. It does not accept a manifest-only claim. The run command requires every resolved package to remain physically inside the independent `@openclaw/msteams` package directory. It must not consume core or source `node_modules`. Source pnpm relative paths are informational and are not compared with npm paths. Installed/restored relative paths and hashes must match each other.

The canonical caller owns full source build, `plugin-npm-runtime-build`, explicit `OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES=1` packaging of the separately shipped msteams plugin, fresh npm lock/install/ls/audit, complete archive/restoration, and four independent proof cells: installed/restored × Node 24.22.1/24.22.0. msteams is not borrowed from the core package. Helpers do not independently qualify packaging or audit. They require the official package content and real resolver edges in every prefix.

Copy `certificate.cnf` and the seven modules together: `msal-proof.mjs`, `identity.mjs`, `processes.mjs`, `scenario.mjs`, `transport.mjs`, `auth-contract.mjs`, and `certificate.mjs`. Only the two certificate scenarios generate an RSA-2048 key at runtime in memory. A fixed `/usr/bin/openssl req` invocation receives that key solely over stdin and returns a one-day self-signed certificate for `msal-qualification.invalid`; neither material is written to disk. The parent captures one absolute same-host `hrtime.bigint()` deadline before process startup and passes it through its fixed child environment. Startup, identity inspection and key generation consume that original 30-second budget. Key generation must complete within 20 seconds, and both before key generation and immediately before OpenSSL there must still be at least seven seconds: the five-second child limit plus two seconds for joining and finalization. Certificate preparation must finish within 25 seconds and before the parent's original deadline. OpenSSL has a five-second SIGKILL deadline and at most 16 KiB combined output, is joined before return, and inherits only fixed locale/time-zone variables. The adjacent read-only OpenSSL configuration contains only a request subject section; `-subj` supplies the fixed public common name and no host OpenSSL configuration is consumed. The helper verifies the certificate/key pair and self-signature before the actual MSAL signing test. No stored private-key fixture or scanner exception is required.

## Output contract

Capture JSON:

- `schema = msal-consumer-contract-v1`, `passed = true`, `stage = capture`.
- `parents`: ordered Azure Identity then Teams Apps; exact `name`, `version`, `packageSha256`, `entrySha256`, and nested `msal` with name/version/package/entry SHA plus `commonVersion` and `commonPackageSha256`.
- `sourcePaths`: the same identities with source-relative parent and MSAL paths. These paths are not installed-layout assertions.

Runtime JSON:

- `schema = msal-consumer-installed-proof-v1`, `passed = true`, `stage = passed`, actual `node`, `platform`, `arch`, `contractSha256`, `identityReverifiedAfterExecution = true`, `noLiveAzureAuthorizationClaim = true`.
- `identity`: both real parent/MSAL identities, paths relative to the independent plugin root. Hashes equal capture. The name/version of the plugin root is pinned to `@openclaw/msteams@2026.10.4`.
- `cells`: exactly seven ordered scenarios listed below. Every `result` must have `passed = true`, `exitCode = 0`, `signal = null`, `failure = null`, `closed = true`, `elapsedMs < 30000`, `outputBytes <= 262144`.
- Every `result.proof` must have `schema = msal-consumer-scenario-v1`, the matching `scenario`, `passed = true`, `noOutbound = true`, `socketAttempts = 0`, `serverListenCalls = 0` and exactly three passing `cases` named `real-consumer-acquire-and-cache`, `rejection-not-cached`, `transport-abort-rejects-without-success-cache`.
- Every scenario includes `authContract`: exact route mode and managed/OAuth request counts. Managed requests require the exact synthetic App Service URL, GET method, API version, caller resource, selected user identity (or absence of every selector for system identity), and identity header. System federation accepts only the exact exchange token previously issued by that same scenario endpoint, including legitimate cache reuse. Only token hashes/counts are retained.
- Certificate scenarios require the bounded, joined `certificateGeneration` receipt with a verified runtime-generated pair and `signatureChecks > 0`. Other scenarios must report `certificateGeneration: null`. This validates an actual MSAL-generated RS256 or PS256 assertion using the synthetic public certificate, expected issuer/subject/audience and an unexpired claim.
- Every scenario's `callerCancellation.sourceReleasedAndJoined = true` and `beforeRelease.actualEndpointStillOpen = true`. `beforeRelease.transportSignal` records whether a transport signal existed and was aborted. `outcome` records the actual public operation after source release. Caller cancellation outcome is observational, not a success gate for an unsupported public capability.
- Output is created exclusively, never overwritten; failures have `passed = false` and only error category/hash. No tokens, certificate private data, request bodies or absolute paths are printed.

Seven scenarios:

1. `azure-secret`: actual `ClientSecretCredential.getToken`.
2. `azure-certificate`: actual `ClientCertificateCredential.getToken` and real MSAL signing.
3. `azure-managed`: actual `ManagedIdentityCredential.getToken`, user-assigned identity.
4. `teams-secret`: actual `new App(...).tokenProvider.getAppToken`, client secret.
5. `teams-certificate-provider`: actual Teams public token-provider hook backed by an actual Azure certificate credential, matching the OpenClaw consumer pattern.
6. `teams-managed-user`: actual Teams user-assigned managed identity route.
7. `teams-managed-system`: actual Teams system-assigned managed identity to client assertion federation route.

All request scopes, identities, tokens, certificates and endpoint material are synthetic. Azure uses its supported `httpClient.sendRequest` transport seam; Teams/MSAL uses replaced global fetch. Real socket/DNS/HTTP calls and server listen are trapped and cause failure. Transport calls are capped at 32 per child. This fixture does not exercise Azure permissions, actual certificates registered with a tenant, live IMDS availability, interactive/device-code/delegated/agentic-user grants, sovereign cloud routing, or outbound Teams messages.

## Cancellation and limits

Azure Identity's secret/certificate MSAL wrappers do not forward caller `AbortSignal` into their `acquireTokenByClientCredential` calls. Teams' public `getAppToken` does not expose an AbortSignal parameter. This migration does not change either contract. A transport `AbortError` must reject and not populate a successful token cache; subsequent synthetic acquisition verifies the absence of such a cached success. The held-source check deliberately ignores a signal until release: a signal is not evidence that the underlying transport Promise has settled.

The wrapper starts seven children serially, each with a 512 MiB V8 heap cap, 30-second wall cap, clean environment and combined stdout/stderr cap 256 KiB. Timeout/output overflow kills and waits for close. V8 heap is not an RSS limit; the outer Linux qualifier owns the OS memory/PID limits, isolated network namespace and job deadline. Runtime helpers should only execute within that outer offline boundary. No local full dependency preparation or external authentication is implied by this README.

## Local evidence boundary

The local helper-only regression has 20 passing cases on macOS Node 26.4.0. It verifies protocol limits, real synthetic RS256/PS256 crypto, source-settlement discipline, fail-closed package identity and subprocess termination. It does **not** execute the migrated parents. Local minimal dependency preparation exceeded its approved 128 MiB disk cap, was terminated at an observed 170650945 bytes, and was not retried. Its partial old-edge graph is not valid migrated runtime evidence. Actual compatibility remains a hosted Linux requirement.
