# Fork Linux package qualification

This secretless workflow runs only in `leether/openclaw`. It adds a complete
Linux x64 package qualification without changing upstream CI or review gates.

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
