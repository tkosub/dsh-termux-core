#!/usr/bin/env bash
# dsh-apply-015-patches.sh — post-install patcher for DSH 0.1.5-rc.1 on Termux.
#
# Run AFTER `npm install -g @deepseek-ai/dsh@0.1.5-rc.1` (via provision.sh or
# directly) and BEFORE restarting dsh.
#
# Applies the Termux/Android fixes for 0.1.5:
#   1. sharp WASM fallback  — android-arm64 has no native sharp prebuilt, so we
#      install the @img/sharp-wasm32 runtime into sharp's own node_modules.
#   2. flock addon          — Bionic-compiled system.node + android-aware
#      flock.js loader (installed by flock/install-android-flock.sh; this
#      patcher ensures it runs). Without it, dsh's session-write lease throws
#      ERR_FLOCK_UNSUPPORTED_PLATFORM on Android.
#   3. hard-link -> rename  — Android SELinux blocks hard links in app-private
#      storage (f2fs), so dsh's session writer and the V0->V3 migration publish
#      sites must use rename() instead of link().
#   4. fs-local rename fallback — same SELinux hard-link block breaks the agent
#      write tool for NEW files; this applies dsh-fs-local-link-rename.patch
#      (adopted from ErEbusE/dsh-termux, MIT).
#
# IDEMPOTENT: safe to re-run; each leg checks current state before editing.
set -euo pipefail

PREFIX="${PREFIX:-$(dirname "$(dirname "$HOME")")/usr}"
DSH_DIR="$PREFIX/lib/node_modules/@deepseek-ai/dsh"
SHARP_DIR="$DSH_DIR/node_modules/sharp"

log() { echo "==> $*"; }

# --- 1. sharp WASM fallback ---
if [ -d "$SHARP_DIR" ]; then
  if [ ! -d "$SHARP_DIR/node_modules/@img/sharp-wasm32" ]; then
    log "Installing @img/sharp-wasm32 fallback into sharp tree..."
    ( cd "$SHARP_DIR" && npm install --no-save @img/sharp-wasm32@latest )
  else
    log "@img/sharp-wasm32 already present in sharp"
  fi
fi

# --- 2. flock A-path loader (install script drops the prebuilt + loader) ---
log "Installing flock addon (prebuilt system.node + android-aware loader)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
if [ -x "$REPO_DIR/flock/install-android-flock.sh" ]; then
  bash "$REPO_DIR/flock/install-android-flock.sh" "--prefix=$PREFIX"
else
  echo "WARN: flock/install-android-flock.sh not found next to patcher — flock not installed"
fi

# --- 3. session-writer hard-link -> rename (dsh-session-persistence-jsonl) ---
log "Applying hard-link->rename fix to dsh-session-persistence-jsonl"
JNL=$(find "$DSH_DIR" -path "*@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js" | head -1)
if [ -z "$JNL" ]; then echo "ERR: jsonl index.js not found"; exit 1; fi
python3 - "$JNL" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
changed = []
# import rename if not present
if 'rename' not in src.split('\n')[3] and ', rename,' not in src:
    src = src.replace('link, lstat', 'link, lstat, rename', 1)
    src = src.replace('link, mkdir', 'link, mkdir, rename', 1)
    changed.append('import')
# materializePosix: link(tmp, finalPath) -> rename(tmp, finalPath)
old1 = 'await link(tmp, finalPath);'
new1 = 'await rename(tmp, finalPath);'
if old1 in src:
    src = src.replace(old1, new1)
    changed.append('materializePosix')
# migration publishCurrentExclusive: internals.fs.link -> rename
old2 = 'await internals.fs.link(staged, currentPath);'
new2 = 'await internals.fs.rename(staged, currentPath);'
if old2 in src:
    src = src.replace(old2, new2)
    changed.append('publishCurrentExclusive')
# defaultFileSystem must expose rename for internals.fs.rename (publishCurrentExclusive)
old_dfs = '\tlstat: (path) => lstat(path),\n\tlink,'
new_dfs = '\tlstat: (path) => lstat(path),\n\tlink,\n\trename,'
if '\trename,' not in src and old_dfs in src:
    src = src.replace(old_dfs, new_dfs)
    changed.append('defaultFileSystem.rename')
open(path, 'w', encoding='utf-8').write(src)
print('session-persistence patched:', ', '.join(changed) if changed else 'NO-OP (already patched?)')
PY

# --- 4. agent-write rename fallback (dsh-fs-local, adopted from ErEbusE/dsh-termux, MIT) ---
log "Applying hard-link->rename fallback to dsh-fs-local"
FSL=$(find "$DSH_DIR" -path "*@deepseek-ai/dsh-fs-local/lib/index.js" | head -1)
if [ -n "$FSL" ]; then
  if grep -q "platformLinkDenied" "$FSL"; then
    log "dsh-fs-local already patched"
  else
    PATCH="$REPO_DIR/patches/0.1.5/dsh-fs-local-link-rename.patch"
    if [ -f "$PATCH" ]; then
      ( cd "$(dirname "$FSL")/../.." && patch -p1 --forward < "$PATCH" )         && log "dsh-fs-local patched" || echo "WARN: dsh-fs-local patch did not apply cleanly — manual check"
    else
      echo "WARN: dsh-fs-local patch file not found at $PATCH — skip"
    fi
  fi
else
  echo "WARN: dsh-fs-local lib/index.js not found — skip"
fi

log "DONE. Restart dsh at the host layer to load reapplied patches."
