#!/usr/bin/env bash
# Build the require_builtin.node native addon for android-arm64.
#
# The vendor (deepseek-ai/dsh-node-addon-require-builtin) publishes prebuilt
# optional packages for nine platforms — Linux (glibc/musl), macOS, Windows —
# but NOT android-arm64. Published installs ship no sources and fail closed.
#
# This script builds the addon from the vendor's source on-device, with a
# bionic getter-parser patch (patches/bionic-require-builtin.patch) that adds
# the android-arm64 platform branch. The patch reuses the vendor's own
# MatchArm64AapcsFieldGetter walker, which already accepts the bionic getter
# shape (bti c; ldr x0, [x0, #imm]; ret).
#
# The binary is installed at the path the loader's local-build fallback
# expects: build/napi/napi-v9-android-arm64/require_builtin.node
set -euo pipefail

VENDOR_REPO="https://github.com/deepseek-ai/dsh-node-addon-require-builtin.git"
VENDOR_COMMIT="36e2a4c9505fd4d05216f2fa9745676cd06d0012"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH_FILE="$REPO_DIR/patches/bionic-require-builtin.patch"
BUILD_DIR="${TMPDIR:-/tmp}/require-builtin-build"
DSH_ROOT="${1:?usage: build-require-builtin.sh <dsh-root>}"

log() { printf '==> %s\n' "$*"; }

log "Cloning vendor addon repo at $VENDOR_COMMIT"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"
git init --quiet
git remote add origin "$VENDOR_REPO"
git fetch --depth 1 --quiet origin "$VENDOR_COMMIT"
git checkout --quiet FETCH_HEAD

log "Applying bionic getter-parser patch"
git apply "$PATCH_FILE"

log "Installing node-addon-api headers"
npm install node-addon-api --no-save --silent

log "Building require_builtin.node for android-arm64"
cd packages/native
SRC="src/node_api_addon.cc src/debug_trace.cc src/native_types.cc src/runtime_symbol.cc src/require_builtin_probe.cc src/runtime_context/helper.cc src/runtime_context/platform.cc src/runtime_context/darwin_arm64.cc src/runtime_context/darwin_x64.cc src/runtime_context/linux_glibc_arm64.cc src/runtime_context/linux_glibc_x64.cc src/runtime_context/linux_android_arm64.cc src/runtime_context/win32_arm64.cc src/runtime_context/win32_x64.cc src/runtime_context/win32_ia32.cc src/runtime_probe/helper.cc src/runtime_probe/platform.cc src/runtime_probe/getter_decoder.cc src/runtime_probe/posix.cc src/runtime_probe/win32_common.cc src/runtime_probe/darwin_arm64.cc src/runtime_probe/darwin_x64.cc src/runtime_probe/linux_glibc_arm64.cc src/runtime_probe/linux_glibc_x64.cc src/runtime_probe/linux_android_arm64.cc src/runtime_context/runtime_profile.cc src/runtime_context/runtime_profile_napi.cc src/runtime_compat_napi.cc"
c++ -shared -fPIC -pthread -std=c++17 -Wall -Wextra -Wno-unused-parameter -Wno-cast-function-type-mismatch -fno-exceptions -fvisibility=hidden -DNAPI_VERSION=9 -DNARB_BACKEND=1 -DNARB_PRODUCT=1 -DNODE_ADDON_API_DISABLE_CPP_EXCEPTIONS -DNODE_GYP_MODULE_NAME=require_builtin -I "$PREFIX/include/node" -I "$BUILD_DIR/node_modules/node-addon-api" $SRC -o require_builtin.node

log "Installing into $DSH_ROOT"
DEST="$DSH_ROOT/node_modules/node-addon-require-builtin/build/napi/napi-v9-android-arm64"
mkdir -p "$DEST"
cp require_builtin.node "$DEST/require_builtin.node"

log "Verifying the bionic probe"
node --expose-internals -e "
const addon = require('$DEST/require_builtin.node');
const info = addon.getNativeBindingInfo();
if (info.backend !== 'napi' || info.abi !== 'napi-v9') throw new Error('bad binding info: ' + JSON.stringify(info));
const realm = addon.requireBuiltin('internal/bootstrap/realm');
if (typeof realm.require !== 'function') throw new Error('realm.require is not a function');
const cjs = realm.require('internal/modules/cjs/loader');
if (!cjs || typeof cjs !== 'object') throw new Error('cjs loader not returned');
console.log('  bionic probe: PASS');
"

log "Done."
