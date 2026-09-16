#!/usr/bin/env bash
# provision.sh — install or update DeepSeek Harness (dsh) on Termux/Android.
#
# One script, two modes:
#   * FRESH INSTALL : idempotent — run it on a new Termux and you get a working dsh.
#   * UPDATE        : run the SAME script on an existing install; it detects what
#                     is already there, re-pins the target version, and re-applies
#                     every Termux patch (patchers are no-ops when already applied).
#
# Zero personal data lives here. Host-specific tweaks go in a LOCAL patch file
# you pass with --with-local-patches (see patches/local-patches.d/README.md).
#
# Design notes (why each fix exists) — see docs/patch-matrix.md for the full map:
#   * node-gyp common.gypi android_ndk_path  -> node-pty native build (missing NDK)
#   * sharp @img/sharp-wasm32 fallback        -> no android-arm64 sharp prebuilt
#   * launcher wrapper --expose-internals     -> HMR plugin requirement
#   * version-targeted patchers (patches/*)   -> flock addon, hard-link->rename, etc.
#   * pi-ai thinking fix is UPSTREAMED in pi-ai 0.85.1 (no patching needed there).
#
# Safety: this script ONLY writes inside $PREFIX (Termux system), $HOME/.dsh, and
# $HOME/.cache. It never touches your personal bridges, relays, or model config.

set -euo pipefail

# --- Configuration ------------------------------------------------------------
# Termux prefix. On Android this is /data/data/com.termux/files/usr; on a real
# Linux or a proot userland it can point elsewhere. All paths below derive from it.
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"

# The pinned dsh version this repo's patchers are validated against.
DSH_VERSION="${DSH_VERSION:-0.1.5-rc.1}"

# npm packages whose postinstall (native addon) scripts must be allowed.
ALLOW_SCRIPTS="@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs"

# Where the patchers live (relative to this repo).
# NOTE: package-level patches (sharp wasm, flock addon, hard-link->rename, etc.)
# are OWNED by the version patchers below; provision.sh only dispatches to them.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY_015="$REPO_DIR/patches/0.1.5/dsh-apply-015-patches.sh"

NPM_GLOBAL_ROOT="$(npm root -g)"
DSH_ROOT="$NPM_GLOBAL_ROOT/@deepseek-ai/dsh"
DSH_BIN="$DSH_ROOT/lib/bin.js"
SHARP_DIR="$DSH_ROOT/node_modules/sharp"
WRAPPER="$DSH_ROOT/dsh-termux-wrapper.sh"
NODE_VER="$(node -v)"
NODE_VER_SHORT="${NODE_VER#v}"          # strip leading 'v' (cache dir is 26.4.0, not v26.4.0)
GYP_GYPI="$HOME/.cache/node-gyp/$NODE_VER_SHORT/include/node/common.gypi"
DSH_BIN_LINK="$PREFIX/bin/dsh"

FORCE=0
LOCAL_PATCHES=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --force)
            FORCE=1
            shift
            ;;
        --with-local-patches)
            if [[ -n "${2:-}" ]]; then
                LOCAL_PATCHES="$2"
                shift 2
            else
                warn "--with-local-patches requires a FILE argument"
                shift
            fi
            ;;
        *)
            warn "Unknown argument: $1 (ignored)"
            shift
            ;;
    esac
done

log() { echo "==> $*"; }
warn() { echo "!!! $*" >&2; }

# --- Preflight ----------------------------------------------------------------
if [[ ! -d "$PREFIX" ]]; then
    warn "PREFIX '$PREFIX' does not exist. Is this Termux/Android?"
    exit 1
fi

# --- 1) Termux build/runtime deps ---------------------------------------------
log "Ensuring Termux packages"
pkg install -y cmake python libandroid-spawn libvips pkg-config clang make >/dev/null

# --- 2) Patch node-gyp common.gypi (node-pty native build on Android) ---------
# node-pty's gyp references android_ndk_path, which Termux lacks; we define the
# variable so the native build compiles against the Termux sysroot instead.
if [[ -f "$GYP_GYPI" ]]; then
    if grep -q "I<(android_ndk_path)/sources/android/cpufeatures" "$GYP_GYPI" && ! grep -q "android_ndk_path%" "$GYP_GYPI"; then
        log "Patching node-gyp common.gypi (android_ndk_path)"
        python3 - "$GYP_GYPI" "$PREFIX" <<'PY'
import sys
path, prefix = sys.argv[1], sys.argv[2]
s = open(path, encoding="utf-8").read()
s = s.replace(
    "'cflags': [ '-fPIC', '-I<(android_ndk_path)/sources/android/cpufeatures' ],",
    "'cflags': [ '-fPIC' ],")
s = s.replace(
    "['OS == \"android\"', {",
    "['OS == \"android\"', {\n            'variables': { 'android_ndk_path%': '%s' }," % prefix)
open(path, "w", encoding="utf-8").write(s)
print("patched", path)
PY
    else
        log "node-gyp common.gypi already patched — skipping"
    fi
else
    warn "$GYP_GYPI not found yet (run once, then re-run to apply the node-gyp patch)"
fi

# --- 3) Ensure dsh package at the pinned version ------------------------------
# UPDATE: if dsh is already installed at a DIFFERENT version, re-install the
# pinned one. If it matches, skip the (expensive) npm install unless --force.
CURRENT_VER=""
if [[ -f "$DSH_ROOT/package.json" ]]; then
    CURRENT_VER="$(python3 -c "import json;print(json.load(open('$DSH_ROOT/package.json')).get('version',''))" 2>/dev/null || true)"
fi

if [[ "$CURRENT_VER" != "$DSH_VERSION" || "$FORCE" == 1 ]]; then
    log "Installing @deepseek-ai/dsh@$DSH_VERSION (was: ${CURRENT_VER:-none})"
    npm install -g --allow-scripts="$ALLOW_SCRIPTS" "@deepseek-ai/dsh@$DSH_VERSION"
else
    log "@deepseek-ai/dsh@$CURRENT_VER already at target — skipping npm install (use --force to reinstall)"
fi

# --- 4) Launcher wrapper (node --expose-internals) -----------------------------
# dsh's HMR plugin needs --expose-internals, which NODE_OPTIONS forbids, so dsh
# is invoked through a wrapper that passes the flag directly.
log "Installing dsh launcher wrapper (node --expose-internals)"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
# Termux: dsh's HMR plugin requires --expose-internals (NODE_OPTIONS forbids it).
exec node --expose-internals "$DSH_BIN" "\$@"
EOF
chmod +x "$WRAPPER"
if [[ "$(readlink -f "$DSH_BIN_LINK" 2>/dev/null || true)" != "$WRAPPER" ]]; then
    ln -snf "$WRAPPER" "$DSH_BIN_LINK"
    log "$DSH_BIN_LINK -> $WRAPPER"
else
    log "$DSH_BIN_LINK already points to wrapper"
fi

# --- 5) Apply version-targeted Termux patches ----------------------------------
# Each patcher is idempotent and safe to re-run (update path). Failures report
# clearly but do not abort the base install.
case "$DSH_VERSION" in
    0.1.5-rc.1)
        if [[ -x "$APPLY_015" ]]; then
            log "Applying 0.1.5 patches ($APPLY_015)"
            bash "$APPLY_015" || warn "apply-015 reported errors (continuing)"
        fi
        ;;
    *)
        warn "No patcher bundled for dsh $DSH_VERSION — base install only (patches may be needed)"
        ;;
esac

# --- 6) Local personal patches (the public/private seam) ------------------------
# Host-specific tweaks NEVER belong in this repo. Point at your own file:
#     provision.sh --with-local-patches ~/dsh-local-patches.sh
# The file is sourced after all public patches so it can override anything.
if [[ -n "$LOCAL_PATCHES" ]]; then
    if [[ -f "$LOCAL_PATCHES" ]]; then
        log "Applying local patches: $LOCAL_PATCHES"
        # shellcheck disable=SC1090
        bash "$LOCAL_PATCHES" || warn "local patches reported errors (continuing)"
    else
        warn "--with-local-patches: '$LOCAL_PATCHES' not found; continuing without it"
    fi
else
    log "No --with-local-patches given — skipping personal patch hook"
fi

# --- 7) Done -------------------------------------------------------------------
log "DONE. Verify: dsh --version"
log "Next: restart dsh (e.g. via your boot layer, such as ~/.dsh/boot/start-dsh.sh restart) so re-applied patches load."
