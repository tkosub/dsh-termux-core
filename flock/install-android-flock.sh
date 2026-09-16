#!/usr/bin/env bash
# install-android-flock.sh — install the DSH flock Bionic prebuild + android-aware
# loader into an installed @deepseek-ai/dsh tree.
#
# WHY: dsh >= 0.1.5 session-write lease uses @deepseek-ai/node-addon-system/flock.
# The upstream loader admits only linux/darwin and throws
# ERR_FLOCK_UNSUPPORTED_PLATFORM on android (Termux) because platform packages
# exist only for darwin+linux. Android's Bionic libc exposes a fully functional
# flock(2), so we ship a prebuilt android-arm64 binding + a loader that admits
# android and loads it from the host-controlled dir (DSH_FLOCK_PREBUILD_DIR).
#
# USAGE:    bash install-android-flock.sh [--prefix DIR]
#           All forms are accepted: --prefix DIR, --prefix=DIR, bare positional,
#           or the PREFIX environment variable. NOTE: the PREFIX env var has
#           the HIGHEST priority — --prefix/positional only take effect when
#           PREFIX is unset (Termux always sets PREFIX in its environment).
# IDEMPOTENT: safe to re-run; upgrades/updates just re-copy (same-version overwrite).
set -euo pipefail

# --- Resolve PREFIX (never hard-coded) ---
# Priority: env PREFIX > --prefix=DIR / --prefix DIR / bare positional.
PREFIX="${PREFIX:-}"
if [ -z "$PREFIX" ]; then
  case "${1:-}" in
    --prefix=*) PREFIX="${1#--prefix=}" ;;
    --prefix)   PREFIX="${2:-}" ;;
    *)          PREFIX="${1:-}" ;;
  esac
fi
if [ -z "$PREFIX" ]; then
  # Termux sets PREFIX; fall back to the conventional location relative to HOME.
  PREFIX="$(dirname "$(dirname "$HOME")")/usr"
fi

DSH_DIR="$PREFIX/lib/node_modules/@deepseek-ai/dsh"
# This script lives inside the flock package dir; prebuilt/lib are siblings.
FLOCK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREBUILD="$FLOCK_DIR/prebuilt/system.node"
LOADER="$FLOCK_DIR/lib/flock.js"

# Host-controlled store (default ~/.dsh/flock; override via DSH_FLOCK_PREBUILD_DIR)
STORE_DIR="${DSH_FLOCK_PREBUILD_DIR:-$HOME/.dsh/flock}"

log() { echo "==> $*"; }

if [ ! -d "$DSH_DIR" ]; then
  echo "ERR: dsh not found at $DSH_DIR (is it installed? pass --prefix if non-standard)"; exit 1
fi
if [ ! -f "$PREBUILD" ]; then
  echo "ERR: prebuilt not found at $PREBUILD"; exit 1
fi

# 1) Stage the prebuilt into the host store (single host-controlled copy)
log "Staging prebuilt system.node -> $STORE_DIR/"
mkdir -p "$STORE_DIR"
cp -f "$PREBUILD" "$STORE_DIR/system.node"
chmod +x "$STORE_DIR/system.node"

# 2) Locate the live loader in the installed package tree
NA_DIR=$(find "$DSH_DIR" -path "*@deepseek-ai/node-addon-system/lib/flock.js" | head -1 | xargs dirname 2>/dev/null || true)
if [ -z "${NA_DIR:-}" ]; then
  echo "ERR: could not locate @deepseek-ai/node-addon-system/lib/flock.js under $DSH_DIR"; exit 1
fi

# 3) Install the android-aware loader as a drop-in replacement
log "Installing android-aware flock.js -> $NA_DIR/flock.js"
cp -f "$LOADER" "$NA_DIR/flock.js"

log "DONE. flock prebuild + loader installed."
log "Store:    $STORE_DIR/system.node"
log "Loader:   $NA_DIR/flock.js"
log "Next:     restart dsh at the host layer so the new lock path is live."
