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
"${guard[@]}" 3600 pnpm build
"${guard[@]}" 900 node scripts/package-openclaw-for-docker.mjs --skip-build \
  --allow-unreleased-changelog --output-dir "$FORK_ARTIFACT_DIR" \
  --output-name openclaw-candidate.tgz
sha256sum --check --strict "$FORK_ARTIFACT_DIR/source-inputs.sha256"
cp pnpm-lock.yaml "$FORK_ARTIFACT_DIR/source-pnpm-lock.yaml"

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

offline() {
  # Each proof gets a fresh network namespace with only loopback available.
  "${guard[@]}" "$1" sudo -n unshare --net -- bash -c \
    'ip link set lo up; exec runuser -u "$1" -- "${@:2}"' _ "$(id -un)" "${@:2}"
}
state="$RUNNER_TEMP/fork-native-synthetic"
for phase in initial candidate rollback; do
  version=24.22.0
  test "$phase" != candidate || version=24.22.1
  runtime="$FORK_NODE_ROOT/node-v$version-linux-x64/bin/node"
  offline 120 "$runtime" "$source_root/scripts/fork-linux/native-smoke.cjs" \
    "$FORK_RUNTIME_DIR" "$state" "$phase" > "$FORK_ARTIFACT_DIR/native-$phase.json"
done
offline 120 "$FORK_NODE_ROOT/node-v24.22.1-linux-x64/bin/node" \
  "$FORK_RUNTIME_DIR/node_modules/openclaw/openclaw.mjs" --version \
  > "$FORK_ARTIFACT_DIR/installed-version.txt"
for version in 24.22.1 24.22.0; do
  runtime="$FORK_NODE_ROOT/node-v$version-linux-x64/bin/node"
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
offline 120 "$FORK_NODE_ROOT/node-v24.22.1-linux-x64/bin/node" \
  "$source_root/scripts/fork-linux/native-smoke.cjs" \
  "$restore" "$RUNNER_TEMP/fork-restored-native-synthetic" initial \
  > "$FORK_ARTIFACT_DIR/restored-native.json"
for version in 24.22.1 24.22.0; do
  runtime="$FORK_NODE_ROOT/node-v$version-linux-x64/bin/node"
  offline 600 env QUALIFICATION_NETWORK_ISOLATED=1 "$runtime" \
    "$source_root/scripts/fork-linux/installed-http-proof.mjs" \
    "$restore/node_modules/openclaw" "$runtime" "$RUNNER_TEMP/fork-restored-http-synthetic-$version" \
    > "$FORK_ARTIFACT_DIR/restored-http-proof-$version.json"
done
"${guard[@]}" 120 node "$source_root/scripts/fork-linux/package-manifest.mjs"
(cd "$FORK_ARTIFACT_DIR" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
