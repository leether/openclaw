# Fork Linux package qualification

This secretless workflow runs only in `leether/openclaw`. It adds a complete
Linux x64 package qualification without changing upstream CI or review gates.

The source build uses the checked-in frozen pnpm lock. A standalone npm install
is resolved once into a retained npm lock, installed with `npm ci`, and archived
with its production dependencies. The npm tarball alone is not an offline
runtime. Both verified Node runtime archives are included separately.

After installation, native ABI and shared synthetic SQLite state are checked
with Node 24.22.0, 24.22.1, and 24.22.0 again. Installed Gateway tests run in a
network namespace with loopback only. They check authentication, stale owner
rejection, 480/240-second protocol acceptance, and HTTP cancellation while a
real plugin tool is still executing. These tests use a synthetic provider;
they do not wait for 480 seconds or measure production performance.

The success artifact includes `qualification.json`, `SHA256SUMS`, the canonical
package, the complete runtime installation, dependency locks, and Node input
signature evidence. Synthetic diagnostic artifacts can also be uploaded after a
failure; their existence does not mean qualification passed. No deployment is
performed by this workflow.

For an isolated offline restore, verify `SHA256SUMS`, extract the runtime archive
into a new prefix, and extract the desired verified Node archive into a separate
runtime directory. Invoke that Node binary with the restored
`node_modules/openclaw/openclaw.mjs`. A production migration still needs its own
current queue, producer, state preservation, and rollback gates.
