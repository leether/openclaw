# Discord independent installed-package qualification

The helper consumes the actual separately packaged `@openclaw/discord` tree. It does not load the SDK from the source checkout or core package. Its implementation and cases use only public synthetic data. The reviewed derived probes and official Discord command schema retain the adjacent MIT license. `frozen/probe-provenance.json` records the original delivery, the product baseline and current probe hashes; historical results do not qualify these new bytes.

## Capture and execution

After the canonical source build and Discord `plugin-npm-runtime-build` / `plugin-npm-package-manifest --run` preparation, freeze the generated assets:

```sh
node discord-proof.mjs capture <sourceRoot> <expected-contract.json>
```

`sourceRoot` contains `patches/zod4-consumers.json` and `extensions/discord`. Capture checks the exact SDK source patch inputs and contract, resolves Zod from the actual source SDK and pins its package bytes as `sdk.zodPackageSha256`; it reads generated files but does not build them. The canonical build receipt and before/after source-input qualification remain the caller's responsibility.

After a fresh independent plugin npm installation, and again after extracting its archive into a fresh prefix:

```sh
node discord-proof.mjs <prefix/node_modules/@openclaw/discord> <expected-contract.json> <out.json>
```

The second argument may be the source root for an immediate capture-and-check, but installed/restored CI should use the same frozen JSON. Output files are exclusive creates; existing evidence is never overwritten.

Run all four combinations separately: installed/restored × Node 24.22.1/24.22.0. The caller must assert the exact Node versions, Linux platform, `passed:true`, artifact identity and all four results. This helper does not turn a macOS result into Linux qualification.

## Package and entry checks

- Reuses `verifyPackageTree` from the common `patched-consumer-contract.mjs`. It verifies the complete 231-file SDK carrier tree, including all 227 runtime outputs, exact modes and hashes. The SDK's top-level `node_modules` is explicitly excluded as installer/dependency space, not counted as part of the 231 files; the production install graph and audit are separate gates.
- SDK `package.json`, CJS resolution, actual ESM import condition and real paths must belong to the supplied plugin root. A source pnpm store, outer prefix, core package or another installation is rejected. No permissive hoist fallback is implemented.
- Resolves `zod/package.json` with `createRequire` rooted at the actual SDK package. Requires Zod 4.6.6 and a physical path inside the same plugin root; requires its package hash to equal the source capture, and reports its relative path and package hash. Source pnpm paths are not compared with installed npm paths; both must belong to their own declared root. This is additional to the SDK's frozen embedded Zod implementation identity.
- Native ESM runs in a real `node --input-type=module -e` child whose cwd is the plugin package. It uses `import.meta.resolve('@discord/embedded-app-sdk')` and bare `import('@discord/embedded-app-sdk')`; CJS uses the actual plugin-rooted `require`. The public SDK communication probe executes against those namespaces after synthetic window setup.
- Internal command/schema probes load only the already verified SDK package. Each format records 86 compatibility assertions, all 13 generated commands, 19 error/default/path cases and public communication checks with three commands. The three-element/max-one case rejects with zero element visits.
- `assets/embedded-app-sdk.mjs` from the source maps to installed `dist/assets/embedded-app-sdk.mjs`. All declared static assets plus `controlUi.entry`/styles are hash-bound. The installed SDK asset also executes the same public communication probe; this is not a browser rendering proof.
- Rechecks the carrier, Zod identity, generated assets and manifest after every child has settled. This assumes the CI-owned tree is not concurrently modified; two snapshots are not a general filesystem immutability primitive.

## Probe provenance

The lint repair preserves all compatibility and error/default/path assertions. Alongside the synthetic `Error` case, the compatibility probe instantiates the installed SDK and passes a synthetic `ERROR` frame through its real `sendCommand` owner. It observes the unchanged plain-object rejection and exercises the installed `setOrientationLockState` compatibility factory. Exact primary/fallback arguments, two distinct nonces, one rejection, two command frames, no pending commands and listener cleanup are required. This uses no manual plain-object throw and no replacement SDK implementation. Both formats must run again against the installed and restored packages; prior 86/13/19 results remain historical. The official SDK carrier manifest, patches and package integrity values are unchanged.

`contracts.mjs` pins the reviewed provenance file SHA and verifies each current probe's bytes against it. Capture and every installed/restored report carry this exact identity. The four-path aggregate independently obtains the identity from that same source owner and rejects absent, altered or historical probe hashes, including four mutually consistent reports with the wrong source provenance.

The SDK resolver consumes the validated source or installation contract name, whose exact value is fixed by `SDK_TREE` and `validateContract`. Its dependency owner is the supplied Discord plugin package, not the root proof-tool package. No dependency-ignore rule or outer-hoist fallback is used.

## Reports

Capture schema: `discord-installed-contract-v1`. It contains `plugin`, fixed `sdk`, exact `sdkTree`, `sourceProvenance`, `derivedProbes`, `controlUi` and `assets[]` with relative `source`/`installedPath`, bytes and SHA256.

Result schema: `discord-installed-proof-v1`:

- `passed`, `node`, `platform`, `arch`, `stage`, `identityReverifiedAfterExecution`.
- `identity`: plugin/SDK name and version, package/runtime counts, CJS/ESM relative entry paths, `resolvedZodVersion`, `zodPackageRelative`, excluded dependency-space description.
- `artifactHashes`: frozen manifest, SDK carrier tree, SDK/Zod package hashes, CJS/ESM entry hashes, canonical JSON contract hash, installed asset hashes and the verified derived-probe provenance/hashes.
- `formats.cjs` / `formats.esm`: `compatChecks:86`, `generatedCommands:13`, `errorCases:19`, the separate `nativePlainErrorFallback` result, public SDK result with actual assertion count and `commands:3`, and detailed child receipts.
- `assets.generatedSdk`: public communication result for the installed static asset. `attempts[]` retains each completed child even if later qualification fails.

No local absolute paths, command lines, environment secrets or raw child stderr are put in result JSON. Failure messages and child stderr are hashed. Invalid/missing fields and mismatches fail closed; a failed child never becomes a successful report.

## Bounds and integration

Seven children execute serially. Each uses at most 512 MiB V8 heap, 30 seconds and 256 KiB combined output. Timeout/output overflow sends SIGKILL and waits for `close`; only hashes of stderr are retained. Child environments do not inherit `NODE_OPTIONS`, `NODE_PATH` or credentials. V8 is not an RSS limit. The qualification owner supplies the 10 GiB / 512-PID / 120-minute outer scope and OS network namespace.

Copy the delivery file allowlist from `delivery-manifest.json`. The local common verifier is an exact read-only snapshot of the source owner's version; integrate using the owner's authoritative file rather than maintaining a second implementation. Its `yaml` import is a proof-tool dependency, never an SDK module fallback. No private fixtures, `node_modules` symlink, old evidence or local preparation scripts belong in public CI.

Local evidence is intentionally weaker: frozen SDK and existing Zod files were copied; the small SDK asset used canonical esbuild options; Control UI is synthetic. It is not a fresh npm install, full plugin build, browser test, Linux run or restore qualification.
