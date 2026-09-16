#!/usr/bin/env bash
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DSH_ROOT="${DSH_ROOT:-$(npm root -g)/@deepseek-ai/dsh}"
export DSH_ROOT
python3 "$REPO_DIR/scripts/patch.py" "$DSH_ROOT" --check
bash "$REPO_DIR/flock/install-android-flock.sh"
node "$REPO_DIR/scripts/install-sharp.mjs" "$DSH_ROOT"
python3 "$REPO_DIR/scripts/patch.py" "$DSH_ROOT"
