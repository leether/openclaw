# Fork Linux package qualification

This secretless workflow runs only in `leether/openclaw`. It adds a complete
Linux x64 package qualification without changing upstream CI or review gates.

A focused four-file shared-worker regression runs through the repository's normal
non-isolated agents runner before packaging. It requires cancelled Code Mode
fixtures to release and join their actual source Promises, and retains the
timer/actual-tool zero-drain assertions. Its single worker exposes process-global
state leaks; the canonical full shard still uses its normal scheduling policy.
The database-backed Code Mode lifecycle fixture runs separately through its
existing infra owner, including worker preparation. The private-completion
receipt regression uses its existing Gateway server owner and waits for the
recorder's persistence barrier before reading the abandoned outcome. The status
scope cases use their existing Gateway database-worker owner with explicit idle queue
and Cron fixtures, rather than weakening the production drain reader. Each
group has a 600-second outer deadline and retains its JSON result with diagnostics.
Historical shard logs do not identify each file's worker, so they cannot uniquely
assign a leaked count to one prior fixture by timestamp alone.

The manual `resolve-lock` mode only exports a lock candidate when an approved
dependency change cannot be resolved within the local host's resource budget.
It uses the exact selected source commit, verified Node 24.22.1, and the declared
pnpm 12.5.1 with normal supply-chain policies and `--ignore-scripts`. It runs in
a separate 4 GiB, zero-swap, 256-process, ten-minute scope; its resolver has a
570-second deadline and a 2 MiB output cap. Every package manifest, configuration
and patch input is hashed before and after, and only the tracked lock may change.
The resulting artifact records the actual exit and is never package qualification
or an automatic commit. Review and accept its dependency delta, then use the
normal frozen installation and complete qualification on the resulting commit.
The default mode remains `qualify`; the two jobs are mutually exclusive.

The source build uses the checked-in frozen pnpm lock. The compiler uses the
existing 6 GiB tsdown heap setting inside a 10 GiB memory scope; declaration
concurrency still follows the repository's capacity checks. Native Go compilers
use the existing CI settings `GOMAXPROCS=2`, `GOGC=30`, and `GOMEMLIMIT=3GiB`;
the Go soft memory target does not replace the scope's hard limit or omit any
declaration stage. A standalone npm install
is resolved once into a retained npm lock, installed with `npm ci`, and archived
with its production dependencies. The npm tarball alone is not an offline
runtime. Both verified Node runtime archives are included separately.
The standalone installed production graph also runs `npm audit --omit=dev
--audit-level=high`; its result is required independently of the source-lock audit.

The exact A2UI and Discord SDK migrations are checked against
`patches/zod4-consumers.json` before and after the full build. These checks bind
the original registry SRI, applied patch, actual Zod edge, and published package
bytes; package-manager links and generated shims are separately classified.
Canvas's A2UI dependencies are bundled by the core build. Qualification follows
the actual Canvas register/JSONL/compose module closure and both generated
browser bundles, without inventing standalone A2UI npm dependencies in core.
The repository's managed Playwright Chromium owner prepares the browser inside
the existing resource/time budget. Installed/restored v0.8 and v0.9 assets must
match the frozen build and pass all four actual-browser cases offline.

On Ubuntu 24.04, a downloaded Chromium may be refused user namespaces by
AppArmor. This qualification uses Chromium's documented exact-path `userns`
permission, with a unique root-owned receipt and policy; it does not change the
global sysctl, disable the browser sandbox, substitute a browser, or install a
setuid helper. Only the prepared UI Playwright executable is eligible. The
policy helper is specific to an exclusive, secretless, disposable GitHub-hosted
job. That runner owns the browser cache: inode/hash checks and a held file
descriptor bind the actual launch, but are not protection from a concurrent
privileged or same-UID writer.

A small real browser prerequisite runs before the full build. It and the final
four-case proof require Chromium's actual namespace/PID/network/seccomp status,
the exact live AppArmor label/executable, and real renderer `Seccomp=2` and
`NoNewPrivs=1` in the worker cgroup. Each final Canvas page also checks renderer
state. Both retain the existing 1 GiB/no-swap, 20-second worker and 60-second
outer deadline, managed process-tree join, and loopback-only OS namespace. The
prerequisite does not count as an installed Canvas consumer pass.

On success, error, timeout or interruption, profile retirement first checks the
unchanged executable and global setting, then inventories the runner's processes
for the exact policy/executable. Any live/unknown process, partial load, failed
unload or drift preserves the root-owned recovery files and fails qualification.
The workflow's failure reconciliation uses the same idempotent owner; it never
unloads a possibly occupied policy or converts a failed proof to success. The
unique receipt, early prerequisite, final proof and confirmed retirement are
required by the final package manifest. Root-owned recovery files remain until
the disposable runner is destroyed.

See Chromium's [AppArmor userns guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).
The original `No usable sandbox` failure alone does not prove a particular
kernel AppArmor denial; the new receipts establish the path actually used.

Discord has its own canonical plugin build/pack and a fresh npm installation.
Its lock, complete dependency graph, high/critical audit, and full runtime
archive are retained separately from core. Both Node versions exercise the
actual SDK ESM/CJS exports, embedded parser, errors/defaults, and generated SDK
browser asset on installed and restored paths. This synthetic SDK qualification
does not connect to Discord or prove production channel credentials or delivery.

Teams is separately built and packed with its canonical runtime dependency
bundle enabled. Its fresh npm graph and offline runtime preserve the two
parent-specific MSAL 7.1.0 edges; installed/restored authentication proofs use
synthetic transports, never live Azure credentials. Core's actual Undici 8.12.2
also exercises direct HTTP, queued/header/body cancellation, CONNECT proxies,
and the default HTTP-forwarding proxy with real loopback sockets in each of the
four installation/runtime combinations. A queued cancellation must prevent wire
admission; Undici may settle its promise only after the earlier request completes.

After installation, native ABI and shared synthetic SQLite state are checked
with Node 24.22.0, 24.22.1, and 24.22.0 again. Installed Gateway tests run with
both runtimes in separate synthetic states and a network namespace with loopback
only. They check authentication, stale owner
rejection, 480/240-second protocol acceptance, and HTTP cancellation while a
real plugin tool is still executing. These tests use a synthetic provider;
they do not wait for 480 seconds or measure production performance.
The model follows the advertised `tool_call` schema and checks the exact
invocation and catalog identity before accepting a structured success. With the
default compact catalog, drain counts are exactly two at admission (dispatcher
and target), one after cancellation (the target's unfinished source promise),
and zero after settlement. The target executes only once; tool errors cannot be
turned into a successful synthetic answer.
The existing five-second cancellation deadline covers both the HTTP client's
rejection and the server's zero request / one source state. The source response
and socket must remain open until that state is observed.

Before the first OpenClaw CLI invocation, the installed-package proof rejects
pending lifecycle and install-guard markers. A fresh metadata CLI process must
finish within its parent's five-second deadline. Two read-only synthetic Gateway
handlers establish admission before cancellation or deadline expiry; the proof
joins the owned PID and pipes, then separately releases and joins each handler.
The startup environment prevents respawn, compile-cache relocation, automatic
Node selection and container forwarding. This proves the actual installed CLI
with that environment, not an external caller's adapter or a cold OS page cache.

On both installed and restored paths, the bundled npm 12.2.1 CLI also packs and
installs synthetic local packages, updates them, and returns to the first version
with install scripts explicitly disabled. These operations run without external
network access. The production install's script policy is not relaxed. The
http-cache-semantics CVE-2026-93748 remains disputed by its maintainer: an audit
passing for version 4.3.0 is not an independent semantic-fix claim.

Chromium gets a fresh owner-only short `/tmp/oc-canvas-*` directory for its
Unix socket, independent of the long evidence/profile path. The proof records
its owner and filesystem identity, checks the socket path byte limit, and retains
the synthetic directory until disposable runner teardown. Sandbox and cgroup
requirements are unchanged. A real Unix socket fixture checks this boundary.

The success artifact includes `qualification.json`, `SHA256SUMS`, the canonical
package, the complete runtime installation, dependency locks, and Node input
signature evidence. Synthetic diagnostic artifacts can also be uploaded after a
failure; their existence does not mean qualification passed. No deployment is
performed by this workflow. The runtime archive is also extracted to a fresh
prefix, compared entry-by-entry with the archive, and exercised by native and
installed HTTP proofs on both runtimes. Qualifying the package does not select a
production runtime upgrade. Artifacts expire after 90 days; they must be transferred
and verified in a durable archive before expiry. CI storage alone is not a
permanent rollback archive.

A monitor outside the bounded build scope retains the latest cgroup counters
and their sampling time in the separate diagnostic artifact, outside the
checksummed qualification package. A missing or earlier counter sample is not evidence
that a later SIGKILL was an OOM kill.

For an isolated offline restore, verify `SHA256SUMS`, extract the runtime archive
into a new prefix, and extract the desired verified Node archive into a separate
runtime directory. Invoke that Node binary with the restored
`node_modules/openclaw/openclaw.mjs`. A production migration still needs its own
current queue, producer, state preservation, and rollback gates.
