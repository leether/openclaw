# Installed npm and node-gyp consumer qualification

This fixture exercises the installed npm 12.2.1 CLI, its real node-gyp 13.0.0
consumer, and that consumer's exact bundled Undici 6.29.1. It does not replace
`fetch`, the dispatcher, or module loading. A read-only diagnostic subscriber
binds each loopback request to the loaded node-gyp and Undici paths and manifest
hash. The fixture serves only two synthetic header files and a SHA256SUMS file;
it does not compile a native addon or contact an external registry.

Invoke under the existing Linux qualification scope, with a loopback-only
network namespace and `QUALIFICATION_NETWORK_ISOLATED=1`:

```sh
NODE scripts/fork-linux/installed-npm-proof.mjs \
  INSTALLED_OPENCLAW_PACKAGE NODE EMPTY_STATE_ROOT \
  --carrier-roundtrip OFFICIAL_NPM_TGZ OFFICIAL_UNDICI_TGZ DERIVED_NPM_TGZ
```

The original three-argument mode remains useful for a standalone consumer probe.
The final artifact collector requires the optional roundtrip to have executed,
so three-argument output alone never satisfies release qualification.
`NODE` must be the interpreter actually running the proof. Each installed and
restored prefix must execute with both Node 24.22.1 and Node 24.22.0.

## Required execution

The original synthetic npm package pack/install/update/rollback remains
1.0.0 → 1.0.1 → 1.0.0 with lifecycle scripts suppressed. The eight additional
consumer cases are:

1. npm run → node-gyp install downloads and verifies synthetic headers; `--ensure`
   then performs no new request.
2. Explicit proxy uses a real CONNECT tunnel to the exact loopback origin.
3. HTTP_PROXY uses that same real proxy path.
4. `--noproxy=127.0.0.1` bypasses the proxy.
5. Wrong SHASUMS fails with node-gyp's actual checksum error and rolls back the
   installed version and temporary extraction directory.
6. Cancellation before response headers joins the owned npm process group.
7. Cancellation during the held response body joins the owned process group.
8. The actual download helper's returned Node Readable can be destroyed, with
   its error/close and server socket closure observed.

node-gyp's download API does not expose or forward an AbortSignal. Reports must
retain `requestAbortSignalSupported=false`. Cases 6 and 7 test CLI process-group
termination, not a nonexistent request cancellation API. Case 8 tests returned
body destruction only. Cancelling a CLI may leave partial temporary files;
those are retained and reported, never described as successful JavaScript
rollback. No compiler is invoked: `nativeCompilationVerified=false` remains
independent of the full Linux package's native-module qualification.

## Ownership and limits

The repository's `runManagedCommand` owns every child and all descendants with
`requireProcessTreeExit=true`. Each child uses 512 MiB V8, 25 seconds work plus
bounded cleanup, and a 256 KiB combined output cap. A valid cancellation requires
ABORT_ERR, actual child close and a dead process group before the 3.5-second
escalation grace. It then allows up to one separate second for server-side socket
closure, requiring zero sockets before cleanup. Killing a leader alone does not qualify.
The V8 limit is not an OS RSS limit; the external Linux qualification cgroup,
PID cap and wall deadline remain required. No budget is increased by this helper.

Servers bind only 127.0.0.1 and allow a nonce-bound origin, two fixed paths, and an
exact CONNECT destination. They cap requests at 16, tracked socket connections
at 32, and intended response bytes at 1 MiB. Unknown traffic fails. Fixture
cleanup can destroy owned sockets after failure; a passing proof requires zero
open sockets before cleanup, so cleanup cannot manufacture the success signal.
The observer emits only synthetic route metadata, package hashes and process
identities. Child environments do not inherit tokens or proxy credentials.

## Artifact and rollback binding

The optional carrier roundtrip reuses `package-bundled-npm.mts` to authenticate
both official SRI inputs and the exact deterministic derived artifact **before
any main installed npm CLI runs**. The main npm root must match every verified
payload file, byte hash and mode, and the fixed derived file count/tree digest;
reports retain this as `mainInventory` and `mainAuthentication`. The same frozen
verified archive bytes are used for the subsequent roundtrip. An
installer outside the mutable prefix performs official npm → derived npm →
official npm. Every stage compares the complete installed package file/mode/hash
inventory against its verified input archive, verifies the actual package-lock
identity and bundled node-gyp/Undici entries, and executes the real direct/ensure
consumer. Final official payload and lock hashes must equal the initial stage.
All inputs, intermediate state and failed output are retained.

`collectNpmQualification(read, hashFile)` in `qualification.mjs` validates the
four required Node/install/restore reports, their fixed main inventories, archive
hashes, provenance and both
Vitest reports. Each main identity is normalized relative to its own exact npm
root and must match the independently installed derived stage, including package
versions, manifest hashes and selected source hashes. Every main inventory must
also exactly equal that stage's complete inventory. Four identically drifted main
trees cannot use cross-cell equality as a substitute for this fixed authority.
Three-argument probes report `qualificationEligible=false`. It returns `artifactNames` and `artifactHashes` for the final
manifest. The two official-input test titles must be passed, never skipped.
Only the three explicitly listed Windows-only lifecycle assertions may remain
pending on Linux; their names and counts are retained. Synthetic local tests
exercise this validation contract and fixture plumbing; they do not establish
Linux consumer execution.
