#!/usr/bin/env bash
# Linux-only CI input verification. No user or production keyring is used.
set -euo pipefail
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
mkdir -p "$FORK_NODE_ROOT" "$FORK_ARTIFACT_DIR/node-verification"
cd "$FORK_NODE_ROOT"
download() {
  curl --fail --silent --show-error --location --proto '=https' \
    --tlsv1.2 --connect-timeout 20 --max-time 300 --max-filesize 40000000 \
    "$1" --output "$2"
}
download https://nodejs.org/dist/v24.22.1/SHASUMS256.txt SHASUMS256.txt
download https://nodejs.org/dist/v24.22.1/SHASUMS256.txt.sig SHASUMS256.txt.sig
download https://raw.githubusercontent.com/nodejs/release-keys/main/keys/5BE8A3F6C8A5C01D106C0AD820B1A390B168D356.asc release-key.asc
download https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz node-v24.22.1-linux-x64.tar.xz
download https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz node-v24.22.0-linux-x64.tar.xz
printf '%s\n' \
  'fdfbffc969c0f604beff0124d409b33a43b53f5c681d6220f80023e0d6df9dc4  SHASUMS256.txt' \
  '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6  node-v24.22.1-linux-x64.tar.xz' \
  'cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008  node-v24.22.0-linux-x64.tar.xz' | sha256sum --check --strict
mkdir -m 700 keyring
gpg --homedir "$FORK_NODE_ROOT/keyring" --batch --import release-key.asc
gpg --homedir "$FORK_NODE_ROOT/keyring" --batch --status-fd 1 \
  --verify SHASUMS256.txt.sig SHASUMS256.txt > signature-status.txt
grep -F '[GNUPG:] VALIDSIG 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356 ' signature-status.txt
grep ' node-v24.22.1-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum --check --strict
for version in 24.22.0 24.22.1; do
  tar -xJf "node-v$version-linux-x64.tar.xz"
  test "$("$FORK_NODE_ROOT/node-v$version-linux-x64/bin/node" --version)" = "v$version"
done
cp SHASUMS256.txt SHASUMS256.txt.sig release-key.asc signature-status.txt \
  "$FORK_ARTIFACT_DIR/node-verification/"
cp node-v24.22.0-linux-x64.tar.xz node-v24.22.1-linux-x64.tar.xz \
  "$FORK_ARTIFACT_DIR/node-verification/"
sha256sum node-v24.22.0-linux-x64.tar.xz node-v24.22.1-linux-x64.tar.xz \
  > "$FORK_ARTIFACT_DIR/node-verification/runtime-sha256.txt"
printf '%s\n' "$FORK_NODE_ROOT/node-v24.22.1-linux-x64/bin" >> "$GITHUB_PATH"
