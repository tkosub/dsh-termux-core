# Upgrade runbook — dsh on Termux/Android

Re-running `provision.sh` is the upgrade path: it detects the installed dsh
version, reinstalls the pinned one (`0.1.5-rc.1`) only if they differ, and
re-applies every Termux fix. This runbook is the detailed version of what the
script automates, for humans debugging a failed upgrade.

## 0. Safety rules

- **Never upgrade in-session.** Restarting dsh kills the session you are
  working in. Run the upgrade at the host layer (SSH/`adb shell`).
- **Take a snapshot first** if you have an existing install you care about
  (snapshots live outside this repo).
- `provision.sh` never touches the boot layer, secrets, or personal files.

## 1. The one-command path

```bash
bash provision.sh                    # install latest pinned version, or update
bash provision.sh --force            # force reinstall from npm (patches re-applied)
bash provision.sh --with-local-patches ~/dsh-local-patches.sh   # + your personal patch file
```

`provision.sh` on an existing install:
1. Ensures Termux packages.
2. Patches node-gyp `common.gypi` (F5).
3. Installs `@deepseek-ai/dsh@$DSH_VERSION` **only if** the installed version
   differs (or `--force`).
4. Rewrites the launcher wrapper + `$PREFIX/bin/dsh` symlink (F6).
5. Dispatches `patches/0.1.5/dsh-apply-015-patches.sh` — applies the
   package-level fixes (F1–F4).
6. Runs your `--with-local-patches` file (if given) — the personal hook.

## 2. The manual path (for a new dsh version with no patcher yet)

If you're upgrading to a version this repo doesn't have a patcher for yet:

```bash
# 1. Install the target version
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs @deepseek-ai/dsh@<ver>

# 2. Verify the existing patcher's file shapes against the new version first:
#    - session-persistence jsonl anchors: materializePosix `link(tmp, finalPath)`
#      and the migration `internals.fs.link(staged, currentPath)` / `defaultFileSystem.rename`
#    - flock loader: node-addon-system lib shape
#    Drifting patterns must be re-derived, not force-applied.

# 3. Run the 0.1.5 patcher (best-effort; it no-ops when already applied)
bash patches/0.1.5/dsh-apply-015-patches.sh

# 4. Restart dsh at the host layer
#    (your own boot mechanism — this repo does not own the boot layer)

# 5. Add patches/<new-ver>/dsh-apply-<ver>-patches.sh for future users
```

## 3. Verification after upgrade

| Check | Command | Expected |
|---|---|---|
| dsh version | `dsh --version` | the pinned version |
| flock works | `node flock/tests/flock-load-smoke.mjs` | `flock OK` (platform=android) |
| flock exclusion | `node flock/tests/test-flock-addon.cjs` | holder acquires; child `EAGAIN`; release re-acquires |
| session writes | write a session, `ls -la` the `.v3.jsonl.zstd` | file grows, rename-published |
| no hard-link publish | `grep -n "link(" $(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` | no `link(tmp, finalPath)` / `internals.fs.link` publish sites |
| subagent call | one subagent prompt | completes |

## 4. Rollback

In-place upgrades do not destroy the previous state: keep a pre-upgrade
snapshot of the files you care about. To roll back, restore the snapshot and
restart at the host layer.
