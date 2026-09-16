#!/usr/bin/env bash
set -euo pipefail
FLOCK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_ROOT="${DSH_ROOT:-$(npm root -g)/@deepseek-ai/dsh}"
[[ $# == 0 ]] || { echo 'Use DSH_ROOT to select another installation.' >&2; exit 1; }
[[ "$(node -p 'process.platform + "-" + process.arch')" == android-arm64 ]] || { echo 'Android ARM64 is required.' >&2; exit 1; }
STORE_DIR="${DSH_FLOCK_PREBUILD_DIR:-$HOME/.dsh/flock}"
LOADER="$DSH_ROOT/node_modules/@deepseek-ai/node-addon-system/lib/flock.js"
[[ -f "$LOADER" ]] || { echo "Missing file: $LOADER" >&2; exit 1; }
(cd "$FLOCK_DIR/prebuilt" && sha256sum -c SHA256SUMS)
mkdir -p "$STORE_DIR"
STAGED="$(mktemp "$STORE_DIR/.system.XXXXXX")"
trap 'rm -f "$STAGED"' EXIT
cp "$FLOCK_DIR/prebuilt/system.node" "$STAGED"
chmod 755 "$STAGED"
mv -f "$STAGED" "$STORE_DIR/system.node"
STAGED="$(mktemp "$(dirname "$LOADER")/.flock.XXXXXX")"
cp "$FLOCK_DIR/lib/flock.js" "$STAGED"
chmod 644 "$STAGED"
mv -f "$STAGED" "$LOADER"
echo 'Installed Android file locking and safe file creation support.'
