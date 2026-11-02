#!/usr/bin/env bash
# Linux GitHub runner only. Every state directory contains synthetic data.
set -euo pipefail
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test "$(node --version)" = v24.22.1
test "$(pnpm --version)" = 12.5.1
test "$(git rev-parse HEAD)" = "$QUALIFIED_SHA"
mkdir -p "$FORK_ARTIFACT_DIR" "$FORK_RUNTIME_DIR"
test -z "$(ls -A "$FORK_RUNTIME_DIR")"
guard=(python3 scripts/fork-linux/bounded-command.py)
source_root="$PWD"
sha256sum pnpm-lock.yaml package.json > "$FORK_ARTIFACT_DIR/source-inputs.sha256"
"${guard[@]}" 1800 pnpm install --frozen-lockfile \
  --config.supportedArchitectures.os=linux \
  --config.supportedArchitectures.cpu=x64 \
  --config.supportedArchitectures.libc=glibc
# Exercise the leaked-source regression with the normal non-isolated runner in
# one worker. This diagnostic group does not change the canonical shard policy.
"${guard[@]}" 600 node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.agents-core.config.ts --maxWorkers=1 \
  src/agents/code-mode.wait.test.ts src/agents/code-mode-headless.cancellation.test.ts \
  src/agents/code-mode.output.test.ts \
  src/agents/timer-execution-budget.test.ts \
  --reporter=json --outputFile="$FORK_ARTIFACT_DIR/tool-source-settlement-tests.json"
# Database-backed fixtures retain their existing owner and worker preparation.
"${guard[@]}" 600 node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.infra.config.ts --maxWorkers=1 \
  src/agents/code-mode.bridge.lifecycle.test.ts \
  --reporter=json --outputFile="$FORK_ARTIFACT_DIR/tool-source-lifecycle-tests.json"
"${guard[@]}" 600 node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.gateway-server.config.ts --maxWorkers=1 \
  src/gateway/server.private-completion.test.ts \
  --reporter=json --outputFile="$FORK_ARTIFACT_DIR/private-completion-settlement-tests.json"
"${guard[@]}" 600 node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.gateway-database-workers.config.ts --maxWorkers=1 \
  src/gateway/server-methods/server-methods.test.ts \
  -t 'gateway healthHandlers.status scope handling' \
  --reporter=json --outputFile="$FORK_ARTIFACT_DIR/status-scope-drain-tests.json"
"${guard[@]}" 120 node scripts/fork-linux/patched-consumer-contract.mjs \
  "$source_root" "$FORK_ARTIFACT_DIR/patched-source-inputs-before.json"
# Prepare the two fixed official inputs through the managed subprocess owner.
# The synchronous lock/materialization owners only consume this verified cache.
"${guard[@]}" 180 node --input-type=module -e \
  'const { ensureNpmRuntimeArtifact } = await import("./scripts/lib/package-npm-runtime.mts"); await ensureNpmRuntimeArtifact(process.cwd());'
npm_derivation="$source_root/.artifacts/npm-runtime-derivation/npm-12.2.1-undici-6.29.1-v1"
export OPENCLAW_NPM_BUNDLE_OFFICIAL_FIXTURE_DIR="$npm_derivation"
"${guard[@]}" 600 node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.tooling.config.ts --maxWorkers=1 \
  test/scripts/package-bundled-npm.test.ts test/scripts/package-npm-runtime.test.ts \
  test/scripts/generate-npm-package-lock.test.ts test/scripts/installed-npm-proof.test.ts \
  test/scripts/check-openclaw-package-tarball.test.ts \
  --reporter=json --outputFile="$FORK_ARTIFACT_DIR/npm-owner-tests.json"
"${guard[@]}" 120 node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.tooling.config.ts --maxWorkers=1 \
  test/scripts/fork-linux-canvas-proof.test.ts \
  --reporter=json --outputFile="$FORK_ARTIFACT_DIR/canvas-sandbox-owner-tests.json"
"${guard[@]}" 600 node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.tooling.config.ts --maxWorkers=1 \
  test/openclaw-prepack.test.ts \
  --reporter=json --outputFile="$FORK_ARTIFACT_DIR/npm-prepack-tests.json"
"${guard[@]}" 900 node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.package-contract.config.ts --maxWorkers=1 \
  test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts \
  --reporter=json --outputFile="$FORK_ARTIFACT_DIR/npm-pack-lifecycle-tests.json"
cp "$npm_derivation/npm-12.2.1.tgz" "$FORK_ARTIFACT_DIR/npm-original-12.2.1.tgz"
cp "$npm_derivation/undici-6.29.1.tgz" "$FORK_ARTIFACT_DIR/npm-undici-6.29.1.tgz"
cp "$npm_derivation/npm-derived.tgz" "$FORK_ARTIFACT_DIR/npm-derived.tgz"
cp "$npm_derivation/provenance.json" "$FORK_ARTIFACT_DIR/npm-derivation-provenance.json"
# The existing browser owner selects the UI package's managed Chromium. A
# preparation failure is a failed prerequisite, not an installed-browser pass.
"${guard[@]}" 900 node --import ./scripts/tsx.mjs \
  scripts/ensure-playwright-chromium.mts --require-playwright-chromium
# sudo resets session-bus discovery. Bind the runner's actual owned socket
# before carrying only that identity into each loopback-only namespace.
runner_uid="$(id -u)"
runner_runtime="/run/user/$runner_uid"
python3 - "$runner_runtime" "$runner_uid" <<'PYBUS'
import os, stat, sys
root, uid = sys.argv[1], int(sys.argv[2])
assert os.path.realpath(root) == root
assert stat.S_ISDIR(os.lstat(root).st_mode) and os.lstat(root).st_uid == uid
bus = os.lstat(root + '/bus')
assert stat.S_ISSOCK(bus.st_mode) and bus.st_uid == uid
PYBUS
env XDG_RUNTIME_DIR="$runner_runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runner_runtime/bus" \
  systemctl --user show --property=Version --value >/dev/null

offline() {
  # Each proof gets a fresh network namespace with only loopback available.
  "${guard[@]}" "$1" sudo -n unshare --net -- bash -c \
    'ip link set lo up; exec runuser -u "$1" -- "${@:2}"' _ "$(id -un)" env XDG_RUNTIME_DIR="$runner_runtime" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=$runner_runtime/bus" "${@:2}"
}
# The downloaded Chromium needs one exact-path userns permission on Ubuntu 24.04.
# This only runs on a disposable hosted job, with no concurrent untrusted writer.
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
sandbox_owner_file="$FORK_ARTIFACT_DIR/canvas-sandbox-owner.txt"
retire_canvas_policy() {
  local owner
  if [[ -s "$sandbox_owner_file" ]]; then
    IFS= read -r owner < "$sandbox_owner_file"
    "${guard[@]}" 20 sudo -n python3 "$source_root/scripts/fork-linux/canvas-sandbox.py" \
      retire "$owner" > "$FORK_ARTIFACT_DIR/canvas-sandbox-retirement.json"
  fi
}
cleanup_canvas_policy() {
  local status=$?
  trap - EXIT INT TERM
  retire_canvas_policy || status=1
  exit "$status"
}
trap cleanup_canvas_policy EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chromium_executable="$(node --input-type=module -e \
  'import {createRequire} from "node:module"; import path from "node:path"; console.log(createRequire(path.join(process.cwd(),"ui/package.json"))("playwright").chromium.executablePath());')"
"${guard[@]}" 30 sudo -n python3 "$source_root/scripts/fork-linux/canvas-sandbox.py" \
  prepare "$chromium_executable" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" > "$sandbox_owner_file"
IFS= read -r CANVAS_SANDBOX_OWNER < "$sandbox_owner_file"
export CANVAS_SANDBOX_OWNER
cp "$CANVAS_SANDBOX_OWNER/receipt.json" "$FORK_ARTIFACT_DIR/canvas-sandbox-admission.json"
# Fail before the expensive build if real namespace/seccomp startup is unavailable.
offline 60 env QUALIFICATION_NETWORK_ISOLATED=1 CANVAS_SANDBOX_OWNER="$CANVAS_SANDBOX_OWNER" \
  NODE_OPTIONS=--max-old-space-size=512 "$FORK_NODE_ROOT/node-v24.22.1-linux-x64/bin/node" \
  "$source_root/scripts/fork-linux/canvas-proof.mjs" sandbox \
  "$source_root" "$source_root" "$source_root" unused "$FORK_ARTIFACT_DIR/canvas-sandbox-preflight"
"${guard[@]}" 3600 pnpm build
"${guard[@]}" 120 node scripts/fork-linux/patched-consumer-contract.mjs \
  "$source_root" "$FORK_ARTIFACT_DIR/patched-source-inputs-after.json"
cmp "$FORK_ARTIFACT_DIR/patched-source-inputs-before.json" \
  "$FORK_ARTIFACT_DIR/patched-source-inputs-after.json"
"${guard[@]}" 120 node scripts/fork-linux/canvas-proof.mjs capture \
  "$source_root" "$FORK_ARTIFACT_DIR/canvas-capture.json"
"${guard[@]}" 900 node scripts/package-openclaw-for-docker.mjs --skip-build \
  --allow-unreleased-changelog --output-dir "$FORK_ARTIFACT_DIR" \
  --output-name openclaw-candidate.tgz
sha256sum --check --strict "$FORK_ARTIFACT_DIR/source-inputs.sha256"
cp pnpm-lock.yaml "$FORK_ARTIFACT_DIR/source-pnpm-lock.yaml"

# Discord is an independently published plugin. Its canonical pack owner
# preserves patched runtime dependencies; a core tarball cannot prove this path.
discord_pack="$RUNNER_TEMP/fork-discord-package"
discord_runtime="$RUNNER_TEMP/fork-discord-runtime"
mkdir "$discord_pack" "$discord_runtime"
"${guard[@]}" 900 node scripts/lib/plugin-npm-runtime-build.mjs extensions/discord
"${guard[@]}" 1800 node scripts/lib/plugin-npm-package-manifest.mjs \
  --run extensions/discord -- npm pack --ignore-scripts --json --pack-destination "$discord_pack"
discord_tgzs=("$discord_pack"/*.tgz)
test "${#discord_tgzs[@]}" -eq 1
test -f "${discord_tgzs[0]}"
cp "${discord_tgzs[0]}" "$FORK_ARTIFACT_DIR/discord-candidate.tgz"
"${guard[@]}" 120 node scripts/fork-linux/discord/discord-proof.mjs capture \
  "$source_root" "$FORK_ARTIFACT_DIR/discord-capture.json"
sha256sum --check --strict "$FORK_ARTIFACT_DIR/source-inputs.sha256"

# Teams carries the two reviewed parent-specific MSAL overrides in its own
# published dependency bundle. Installing the plugin must not re-resolve the
# original registry parents onto their old MSAL versions.
msteams_pack="$RUNNER_TEMP/fork-msteams-package"
msteams_runtime="$RUNNER_TEMP/fork-msteams-runtime"
mkdir "$msteams_pack" "$msteams_runtime"
"${guard[@]}" 900 node scripts/lib/plugin-npm-runtime-build.mjs extensions/msteams
"${guard[@]}" 1800 env OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES=1 \
  node scripts/lib/plugin-npm-package-manifest.mjs \
  --run extensions/msteams -- npm pack --ignore-scripts --json --pack-destination "$msteams_pack"
msteams_tgzs=("$msteams_pack"/*.tgz)
test "${#msteams_tgzs[@]}" -eq 1
test -f "${msteams_tgzs[0]}"
cp "${msteams_tgzs[0]}" "$FORK_ARTIFACT_DIR/msteams-candidate.tgz"
"${guard[@]}" 120 node scripts/fork-linux/msal/msal-proof.mjs capture \
  "$source_root" "$FORK_ARTIFACT_DIR/msteams-capture.json"
sha256sum --check --strict "$FORK_ARTIFACT_DIR/source-inputs.sha256"

# Resolve a standalone package once, then install exactly the captured npm lock.
# The source build above separately uses the repository's frozen pnpm lock.
"${guard[@]}" 900 npm install --prefix "$FORK_RUNTIME_DIR" --package-lock-only \
  --omit=dev --audit=false --fund=false "$FORK_ARTIFACT_DIR/openclaw-candidate.tgz"
"${guard[@]}" 1800 npm ci --prefix "$FORK_RUNTIME_DIR" --omit=dev --audit=false --fund=false
cp "$FORK_RUNTIME_DIR/package-lock.json" "$FORK_ARTIFACT_DIR/installed-package-lock.json"
"${guard[@]}" 120 npm ls --prefix "$FORK_RUNTIME_DIR" --all --omit=dev --json \
  > "$FORK_ARTIFACT_DIR/installed-dependencies.json"
"${guard[@]}" 300 npm audit --prefix "$FORK_RUNTIME_DIR" --omit=dev --audit-level=high --json \
  > "$FORK_ARTIFACT_DIR/installed-npm-audit.json"
"${guard[@]}" 900 npm install --prefix "$discord_runtime" --package-lock-only \
  --omit=dev --audit=false --fund=false "$FORK_ARTIFACT_DIR/discord-candidate.tgz"
"${guard[@]}" 1800 npm ci --prefix "$discord_runtime" --omit=dev --audit=false --fund=false
cp "$discord_runtime/package-lock.json" "$FORK_ARTIFACT_DIR/discord-installed-package-lock.json"
"${guard[@]}" 120 npm ls --prefix "$discord_runtime" --all --omit=dev --json \
  > "$FORK_ARTIFACT_DIR/discord-installed-dependencies.json"
"${guard[@]}" 300 npm audit --prefix "$discord_runtime" --omit=dev --audit-level=high --json \
  > "$FORK_ARTIFACT_DIR/discord-installed-npm-audit.json"
"${guard[@]}" 900 npm install --prefix "$msteams_runtime" --package-lock-only \
  --omit=dev --audit=false --fund=false "$FORK_ARTIFACT_DIR/msteams-candidate.tgz"
"${guard[@]}" 1800 npm ci --prefix "$msteams_runtime" --omit=dev --audit=false --fund=false
cp "$msteams_runtime/package-lock.json" "$FORK_ARTIFACT_DIR/msteams-installed-package-lock.json"
"${guard[@]}" 120 npm ls --prefix "$msteams_runtime" --all --omit=dev --json \
  > "$FORK_ARTIFACT_DIR/msteams-installed-dependencies.json"
"${guard[@]}" 300 npm audit --prefix "$msteams_runtime" --omit=dev --audit-level=high --json \
  > "$FORK_ARTIFACT_DIR/msteams-installed-npm-audit.json"

state="$RUNNER_TEMP/fork-native-synthetic"
for phase in initial candidate rollback; do
  version=24.22.0
  test "$phase" != candidate || version=24.22.1
  runtime="$FORK_NODE_ROOT/node-v$version-linux-x64/bin/node"
  offline 120 "$runtime" "$source_root/scripts/fork-linux/native-smoke.cjs" \
    "$FORK_RUNTIME_DIR" "$state" "$phase" > "$FORK_ARTIFACT_DIR/native-$phase.json"
done
for version in 24.22.1 24.22.0; do
  runtime="$FORK_NODE_ROOT/node-v$version-linux-x64/bin/node"
  offline 60 env QUALIFICATION_NETWORK_ISOLATED=1 NODE_OPTIONS=--max-old-space-size=512 "$runtime" \
    "$source_root/scripts/fork-linux/undici-proof.mjs" \
    "$FORK_RUNTIME_DIR/node_modules/openclaw" "$FORK_ARTIFACT_DIR/installed-undici-proof-$version.json"
  offline 240 env QUALIFICATION_NETWORK_ISOLATED=1 "$runtime" \
    "$source_root/scripts/fork-linux/msal/msal-proof.mjs" \
    "$msteams_runtime/node_modules/@openclaw/msteams" "$FORK_ARTIFACT_DIR/msteams-capture.json" \
    "$FORK_ARTIFACT_DIR/installed-msteams-proof-$version.json"
  offline 120 env QUALIFICATION_NETWORK_ISOLATED=1 "$runtime" \
    "$source_root/scripts/fork-linux/canvas-proof.mjs" runtime \
    "$FORK_RUNTIME_DIR/node_modules/openclaw" "$FORK_ARTIFACT_DIR/canvas-capture.json" \
    "$FORK_ARTIFACT_DIR/installed-canvas-proof-$version.json"
  offline 240 env QUALIFICATION_NETWORK_ISOLATED=1 "$runtime" \
    "$source_root/scripts/fork-linux/discord/discord-proof.mjs" \
    "$discord_runtime/node_modules/@openclaw/discord" "$FORK_ARTIFACT_DIR/discord-capture.json" \
    "$FORK_ARTIFACT_DIR/installed-discord-proof-$version.json"
  offline 240 env QUALIFICATION_NETWORK_ISOLATED=1 "$runtime" \
    "$source_root/scripts/fork-linux/installed-npm-proof.mjs" \
    "$FORK_RUNTIME_DIR/node_modules/openclaw" "$runtime" "$RUNNER_TEMP/fork-npm-synthetic-$version" \
    --carrier-roundtrip "$npm_derivation/npm-12.2.1.tgz" \
    "$npm_derivation/undici-6.29.1.tgz" "$npm_derivation/npm-derived.tgz" \
    > "$FORK_ARTIFACT_DIR/installed-npm-proof-$version.json"
  offline 600 env QUALIFICATION_NETWORK_ISOLATED=1 "$runtime" \
    "$source_root/scripts/fork-linux/installed-http-proof.mjs" \
    "$FORK_RUNTIME_DIR/node_modules/openclaw" "$runtime" "$RUNNER_TEMP/fork-http-synthetic-$version" \
    > "$FORK_ARTIFACT_DIR/installed-http-proof-$version.json"
done

# Preserve the resolved Linux dependencies for offline restoration; an npm tgz
# alone is explicitly not claimed to contain a complete runtime installation.
"${guard[@]}" 900 tar -C "$FORK_RUNTIME_DIR" -czf "$FORK_ARTIFACT_DIR/openclaw-linux-x64-runtime.tar.gz" .
# Restore the archive to a fresh prefix and exercise that prefix, not the
# original installation. tar --compare checks all extracted entries and bytes.
restore="$RUNNER_TEMP/fork-linux-restored-runtime"
mkdir "$restore"
offline 900 tar -C "$restore" -xzf "$FORK_ARTIFACT_DIR/openclaw-linux-x64-runtime.tar.gz"
offline 900 tar -C "$restore" -dzf "$FORK_ARTIFACT_DIR/openclaw-linux-x64-runtime.tar.gz"
"${guard[@]}" 900 tar -C "$discord_runtime" -czf "$FORK_ARTIFACT_DIR/discord-linux-x64-runtime.tar.gz" .
discord_restore="$RUNNER_TEMP/fork-discord-restored-runtime"
mkdir "$discord_restore"
offline 900 tar -C "$discord_restore" -xzf "$FORK_ARTIFACT_DIR/discord-linux-x64-runtime.tar.gz"
offline 900 tar -C "$discord_restore" -dzf "$FORK_ARTIFACT_DIR/discord-linux-x64-runtime.tar.gz"
"${guard[@]}" 900 tar -C "$msteams_runtime" -czf "$FORK_ARTIFACT_DIR/msteams-linux-x64-runtime.tar.gz" .
msteams_restore="$RUNNER_TEMP/fork-msteams-restored-runtime"
mkdir "$msteams_restore"
offline 900 tar -C "$msteams_restore" -xzf "$FORK_ARTIFACT_DIR/msteams-linux-x64-runtime.tar.gz"
offline 900 tar -C "$msteams_restore" -dzf "$FORK_ARTIFACT_DIR/msteams-linux-x64-runtime.tar.gz"
offline 120 "$FORK_NODE_ROOT/node-v24.22.1-linux-x64/bin/node" \
  "$source_root/scripts/fork-linux/native-smoke.cjs" \
  "$restore" "$RUNNER_TEMP/fork-restored-native-synthetic" initial \
  > "$FORK_ARTIFACT_DIR/restored-native.json"
for version in 24.22.1 24.22.0; do
  runtime="$FORK_NODE_ROOT/node-v$version-linux-x64/bin/node"
  offline 60 env QUALIFICATION_NETWORK_ISOLATED=1 NODE_OPTIONS=--max-old-space-size=512 "$runtime" \
    "$source_root/scripts/fork-linux/undici-proof.mjs" \
    "$restore/node_modules/openclaw" "$FORK_ARTIFACT_DIR/restored-undici-proof-$version.json"
  offline 240 env QUALIFICATION_NETWORK_ISOLATED=1 "$runtime" \
    "$source_root/scripts/fork-linux/msal/msal-proof.mjs" \
    "$msteams_restore/node_modules/@openclaw/msteams" "$FORK_ARTIFACT_DIR/msteams-capture.json" \
    "$FORK_ARTIFACT_DIR/restored-msteams-proof-$version.json"
  offline 120 env QUALIFICATION_NETWORK_ISOLATED=1 "$runtime" \
    "$source_root/scripts/fork-linux/canvas-proof.mjs" runtime \
    "$restore/node_modules/openclaw" "$FORK_ARTIFACT_DIR/canvas-capture.json" \
    "$FORK_ARTIFACT_DIR/restored-canvas-proof-$version.json"
  offline 240 env QUALIFICATION_NETWORK_ISOLATED=1 "$runtime" \
    "$source_root/scripts/fork-linux/discord/discord-proof.mjs" \
    "$discord_restore/node_modules/@openclaw/discord" "$FORK_ARTIFACT_DIR/discord-capture.json" \
    "$FORK_ARTIFACT_DIR/restored-discord-proof-$version.json"
  offline 240 env QUALIFICATION_NETWORK_ISOLATED=1 "$runtime" \
    "$source_root/scripts/fork-linux/installed-npm-proof.mjs" \
    "$restore/node_modules/openclaw" "$runtime" "$RUNNER_TEMP/fork-restored-npm-synthetic-$version" \
    --carrier-roundtrip "$npm_derivation/npm-12.2.1.tgz" \
    "$npm_derivation/undici-6.29.1.tgz" "$npm_derivation/npm-derived.tgz" \
    > "$FORK_ARTIFACT_DIR/restored-npm-proof-$version.json"
  offline 600 env QUALIFICATION_NETWORK_ISOLATED=1 "$runtime" \
    "$source_root/scripts/fork-linux/installed-http-proof.mjs" \
    "$restore/node_modules/openclaw" "$runtime" "$RUNNER_TEMP/fork-restored-http-synthetic-$version" \
    > "$FORK_ARTIFACT_DIR/restored-http-proof-$version.json"
done
offline 60 env QUALIFICATION_NETWORK_ISOLATED=1 CANVAS_SANDBOX_OWNER="$CANVAS_SANDBOX_OWNER" NODE_OPTIONS=--max-old-space-size=512 \
  "$FORK_NODE_ROOT/node-v24.22.1-linux-x64/bin/node" \
  "$source_root/scripts/fork-linux/canvas-proof.mjs" browser \
  "$FORK_RUNTIME_DIR/node_modules/openclaw" "$restore/node_modules/openclaw" \
  "$source_root" "$FORK_ARTIFACT_DIR/canvas-capture.json" "$FORK_ARTIFACT_DIR/canvas-browser"
retire_canvas_policy
trap - EXIT INT TERM
"${guard[@]}" 120 node "$source_root/scripts/fork-linux/package-manifest.mjs"
(cd "$FORK_ARTIFACT_DIR" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
