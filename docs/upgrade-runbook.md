# Upgrade runbook — dsh on Termux/Android

This is the verified upgrade sequence for an EXISTING dsh-on-Termux install.
`provision.sh` is an install **and** update script: re-running it on a live
install detects the current version, reinstalls only if different, and
re-applies every patch (idempotent). This runbook is the fine-grained version
of what the script automates, for humans debugging a failed upgrade.

## 0. Safety rules (non-negotiable)

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
5. Dispatches `patches/0.1.5/dsh-apply-015-patches.sh` — the single owner of
   package-level patches.
6. Runs your `--with-local-patches` file (if given) — the personal hook.

## 2. The manual path (for a new dsh version with no patcher yet)

If you're upgrading to a version this repo doesn't have a patcher for yet:

```bash
# 1. Install pinned
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs @deepseek-ai/dsh@<ver>

# 2. VERIFY the existing patcher's file shapes against the new version first:
#    - session-persistence jsonl anchors: materializePosix `link(tmp, finalPath)`
#      and the migration `internals.fs.link(staged, currentPath)` / `defaultFileSystem.rename`
#    - flock loader: node-addon-system lib shape
#    Drifting patterns must be re-derived, not force-applied.

# 3. Run the 0.1.5 patcher (best-effort; it no-ops guards for upstreamed/absent)
bash patches/0.1.5/dsh-apply-015-patches.sh

# 4. Re-check persona/other config edits if the schema changed
#    (e.g. 0.1.5 renamed persona `persona` -> `personaPrefix`)

# 5. Restart dsh at the host layer
#    (your own boot/start mechanism — this repo does not own the boot layer)

# 6. Add patches/<new-ver>/dsh-apply-<ver>-patches.sh for future users
```

## 3. Verification after upgrade

| Check | Command | Expected |
|---|---|---|
| dsh version | `dsh --version` | the pinned version |
| flock works | `node flock/tests/a-path-smoke.mjs` | `A-path OK` (platform=android) |
| flock exclusion | `node flock/tests/test-flock-addon.cjs` | holder acquires; child `EAGAIN`; release re-acquires |
| session writes | write a session, `ls -la` the `.v3.jsonl.zstd` | file grows, rename-published |
| no hard-link publish | `grep -n "link(" $(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` | no `link(tmp, finalPath)` / `internals.fs.link` publish sites |
| subagent call | one subagent prompt | completes |

## 4. Rollback

In-place upgrades do not destroy the previous state: keep a pre-upgrade
snapshot of the files you care about. To roll back, restore the snapshot and
restart at the host layer.

## 5. Known limitations (not fixed — documented honestly)

- **pi-ai 0.85.1's UNUSED `google` (non-Vertex) provider route** still maps
  flash thinking to `MINIMAL`. Only matters if you add a `google` (non-Vertex)
  provider; the `google-vertex` route (used here) is fixed upstream.
