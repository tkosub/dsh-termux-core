#!/usr/bin/env bash
# Install or repair DSH on Termux. Does not start or stop a running server.
set -euo pipefail
log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_VERSION="${DSH_VERSION:-0.1.5-rc.1}"
FORCE=0
LOCAL_PATCHES=""
WEB_TOOLS=0
while (($#)); do
    case "$1" in
        --force) FORCE=1; shift ;;
        --with-local-patches)
            [[ $# -ge 2 && -f "$2" ]] || die '--with-local-patches requires an existing file'
            LOCAL_PATCHES="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
        --with-web-tools) WEB_TOOLS=1; shift ;;
        --help|-h)
            printf 'Usage: bash provision.sh [--force] [--with-local-patches FILE] [--with-web-tools]\n'; exit 0 ;;
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

if [[ "$WEB_TOOLS" == 1 ]]; then
    log 'Installing optional browser + web MCP tools (--with-web-tools)'
    # Termux packages: curl (web-tools fetching), proot-distro (browser
    # backend rootfs), python-pip (nodriver/trafilatura). python itself was
    # installed above; DSH does not need any of this without the flag.
    pkg install -y curl proot-distro python-pip
    if ! proot-distro list 2>/dev/null | grep -qE '^[[:space:]]*\*[[:space:]]+debian([[:space:]]|$)'; then
        log 'Installing the Debian proot distribution (large download)'
        proot-distro install debian
    fi
    log 'Installing Chromium inside the Debian proot rootfs'
    proot-distro login debian -- apt-get update
    proot-distro login debian -- apt-get install -y chromium
    log 'Installing Python dependencies (nodriver, trafilatura)'
    python -m pip install nodriver trafilatura
    # Deployment is a pure copy of the repo files (this is their only
    # canonical source). Rerunning the flag refreshes the live copies.
    MCP_DIR="$HOME/.dsh/mcp"
    mkdir -p "$MCP_DIR/web-tools" "$MCP_DIR/browser-tools"
    cp -f "$REPO_DIR/mcp-web-tools/server.mjs" "$MCP_DIR/web-tools/"
    for f in server.mjs browse.py stealth_browser.py proot_reap.py \
             chromium-proot-launcher nodriver_cf_test.py; do
        cp -f "$REPO_DIR/browser/$f" "$MCP_DIR/browser-tools/"
    done
    chmod 755 "$MCP_DIR/browser-tools/chromium-proot-launcher"
    # Fail fast on syntax errors before declaring the install done.
    python -m py_compile "$MCP_DIR/browser-tools/"*.py
    node --check "$MCP_DIR/web-tools/server.mjs"
    node --check "$MCP_DIR/browser-tools/server.mjs"
    log "MCP tools deployed to $MCP_DIR (web-tools + browser-tools)."
    log 'Wire them as MCP rows in your DSH profile; see browser/README.md.'
    log 'Smoke test: python3 ~/.dsh/mcp/browser-tools/nodriver_cf_test.py'
fi

log 'Checking the installed application'
node "$REPO_DIR/scripts/verify.mjs" "$DSH_ROOT"
"$WRAPPER" --version
log 'Installation checks passed.'
log 'To start: dsh web'
log 'Open the complete address printed by DSH in your phone browser.'
log 'If DSH is already running, stop and start it when your current work is finished.'
