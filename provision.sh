#!/usr/bin/env bash
# Install or repair DSH on Termux. Does not start or stop a running server.
set -euo pipefail
log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_VERSION="${DSH_VERSION:-0.1.5-rc.1}"
FORCE=0
LOCAL_PATCHES=""
while (($#)); do
    case "$1" in
        --force) FORCE=1; shift ;;
        --with-local-patches)
            [[ $# -ge 2 && -f "$2" ]] || die '--with-local-patches requires an existing file'
            LOCAL_PATCHES="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
        --help|-h)
            printf 'Usage: bash provision.sh [--force] [--with-local-patches FILE]\n'; exit 0 ;;
        *) die "Unknown option: $1" ;;
    esac
done
[[ "$DSH_VERSION" == 0.1.5-rc.1 ]] || die "Unsupported DSH version: $DSH_VERSION"
[[ -n "${PREFIX:-}" && -d "$PREFIX" ]] || die 'Run this script inside Termux.'
command -v pkg >/dev/null || die 'Termux package manager not found.'
API="$(/system/bin/getprop ro.build.version.sdk)"
[[ "$API" =~ ^[0-9]+$ && "$API" -ge 30 ]] || die 'Android 11 or newer is required.'
[[ "$(uname -m)" == aarch64 ]] || die 'This installer currently supports ARM64 phones only.'

# Bootstrap Node/npm before asking npm where packages are installed.
log 'Installing required Termux packages'
pkg update -y
if ! command -v node >/dev/null; then pkg install -y nodejs; fi
pkg install -y npm git python clang make cmake pkg-config libandroid-spawn ripgrep
node -e 'if (process.platform !== "android" || process.arch !== "arm64" || Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' \
    || die 'Use the Termux version of Node.js 24 or newer.'
[[ "$(npm --version | cut -d. -f1)" -ge 11 ]] || die 'npm 11 or newer is required. Update the Termux npm package.'

# Termux supplies patched headers; an empty node-gyp cache is fine.
[[ -f "$PREFIX/include/node/common.gypi" ]] || die 'Node.js headers are missing. Reinstall the Termux Node.js package.'
export npm_config_nodedir="$PREFIX"
export SHARP_IGNORE_GLOBAL_LIBVIPS=1
DSH_ROOT="$(npm root -g)/@deepseek-ai/dsh"
CURRENT_VER=""
if [[ -f "$DSH_ROOT/package.json" ]]; then
    CURRENT_VER="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).version' "$DSH_ROOT/package.json")"
fi
if [[ "$CURRENT_VER" != "$DSH_VERSION" || "$FORCE" == 1 ]]; then
    log "Installing DSH $DSH_VERSION"
    npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs "@deepseek-ai/dsh@$DSH_VERSION"
else
    log "DSH $CURRENT_VER is installed; checking and repairing compatibility fixes"
fi
export DSH_ROOT
bash "$REPO_DIR/patches/0.1.5/dsh-apply-015-patches.sh"

WRAPPER="$DSH_ROOT/dsh-termux-wrapper.sh"
WRAPPER_TMP="$(mktemp "$DSH_ROOT/.launcher.XXXXXX")"
printf '#!%s/bin/bash\nexec %q --expose-internals %q "$@"\n' "$PREFIX" "$PREFIX/bin/node" "$DSH_ROOT/lib/bin.js" > "$WRAPPER_TMP"
chmod 755 "$WRAPPER_TMP"
mv -f "$WRAPPER_TMP" "$WRAPPER"
NPM_PREFIX="$(npm prefix -g)"
ln -snf "$WRAPPER" "$NPM_PREFIX/bin/dsh"
if [[ -n "$LOCAL_PATCHES" ]]; then
    log 'Running the additional script'
    bash "$LOCAL_PATCHES"
fi
log 'Checking the installed application'
node "$REPO_DIR/scripts/verify.mjs" "$DSH_ROOT"
"$WRAPPER" --version
log 'Installation checks passed.'
log 'To start: dsh web'
log 'Open the complete address printed by DSH in your phone browser.'
log 'If DSH is already running, stop and start it when your current work is finished.'
