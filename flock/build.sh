#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "${PREFIX:?Run this inside Termux}/include/node/node_api.h" ]]
OUT="${1:-$HERE/prebuilt/system.node}"
mkdir -p "$(dirname "$OUT")"
clang -shared -fPIC -O2 -DNAPI_VERSION=8 -I"$PREFIX/include/node" \
    "$HERE/src/flock.c" -o "$OUT"
sha256sum "$OUT"
