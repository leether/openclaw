# Fork Linux package qualification

This secretless workflow runs only in `leether/openclaw`. It adds a complete
Linux x64 package qualification without changing upstream CI or review gates.

The source build uses the checked-in frozen pnpm lock. The compiler uses the
existing 6 GiB tsdown heap setting inside a 10 GiB memory scope; declaration
concurrency still follows the repository's capacity checks. A standalone npm install
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
