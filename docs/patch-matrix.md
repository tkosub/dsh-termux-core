# Patch matrix — dsh on Termux/Android

Every Termux/Android incompatibility this repo fixes, what it edits, where in
the tree the patcher lives, and whether the fix is upstreamed. Verified against
a live `@deepseek-ai/dsh@0.1.5-rc.1` install on android-arm64 (Termux).

## Legend

- **Patcher**: the file that applies/re-applies the fix.
- **Edit site**: the shipped dsh package file that is modified.
- **Upstreamed?**: `yes` — upstream includes it, nothing to do; `no` — this
  repo must re-apply; `n/a` — not an upstream concern (addon/script).

## The matrix

| # | Fix | Problem (host fact) | Edit site | Patcher | Upstreamed? | Needed again on upgrade? |
|---|---|---|---|---|---|---|
| F1 | sharp WASM fallback | `android-arm64` has no native sharp prebuilt → sharp throws "Could not load the 'sharp' module using the android-arm64 runtime" | `@img/sharp-wasm32` installed inside `sharp/node_modules/` | `patches/<ver>/dsh-apply-<ver>-patches.sh` leg 1 | n/a (addon install) | **Always** — install `@img/sharp-wasm32` whenever sharp updates. Zero build fragility (no node-gyp, no libvips). |
| F2 | flock addon (the 0.1.5+ blocker) | Session-write lease uses `@deepseek-ai/node-addon-system/flock`; upstream ships platform packages only for linux/darwin → `ERR_FLOCK_UNSUPPORTED_PLATFORM` on android | native `system.node` (Bionic/android-arm64) + android-aware `flock.js` loader in the package tree | `flock/install-android-flock.sh` (+ `patches/<ver>` leg 2 ensures it) | no (upstream has no android binding) | **Re-check each upgrade** — loader/file shapes drift; re-stage `system.node` + `flock.js` from `flock/` if changed. Only obsolete if upstream ships an android binding. |
| F3 | session-writer hard-link→rename | Android SELinux blocks `link()` on f2fs in the app domain (EACCES) even for the owner. dsh session writer's `materializePosix` staged tmp + `link()` fails; the 0.1.5 V0→V3 migration `publishCurrentExclusive` also `link()`s. | `dsh-session-persistence-jsonl/lib/index.js` — `materializePosix` + `publishCurrentExclusive` (`internals.fs.link`→`rename`) + `defaultFileSystem.rename` expose | `patches/<ver>/dsh-apply-<ver>-patches.sh` leg 3 | no | **Yes** — re-check no `link(` publish remains after install; string matches may drift. |
| F4 | agent-write hard-link→rename (adopted from ErEbusE/dsh-termux, MIT) | Agent `write` of NEW files fails: `dsh-fs-local` `writeFileAtomic` create-if-absent does `linkFile()`+rethrow → EACCES on Android (SELinux hard-link block). | `dsh-fs-local/lib/index.js` | `patches/0.1.5/dsh-fs-local-link-rename.patch` (0.1.5 patcher leg 4) | no (external MIT patch) | **Yes** — re-apply on every upgrade; re-check the anchor (createIfAbsent→linkFile) if the lib drifts |
| F5 | node-gyp `android_ndk_path` (node-pty native build) | node-gyp copies `process.config.variables.OS = "android"` into gyp; the `OS == "android"` branch references undefined `android_ndk_path`, breaking node-pty's native build. | `~/.cache/node-gyp/<ver>/include/node/common.gypi` | `provision.sh` (base layer) | n/a (build-system patch) | **Always** when node-gyp is (re)installed. |
| F6 | launcher wrapper `--expose-internals` | HMR plugin requires `--expose-internals`; `NODE_OPTIONS` forbids it → must be in the shebang/wrapper. | `dsh` bin wrapper + `$PREFIX/bin/dsh` symlink | `provision.sh` (base layer) | n/a | Re-apply on reinstall; survives in-place upgrades. |
| F7 | (not a patch) koffi | Older koffi needed `--target=aarch64-unknown-linux-android30` to expose `statx`. **koffi 3.3.0 ships `@koromix/koffi-android-arm64` prebuild** — no patch needed. | n/a | none | yes (prebuild exists) | none. Documented so nobody re-adds a native android30 compile. |

## Canonical environment names (use exactly these in docs/scripts)

| Env | Meaning | Set by |
|---|---|---|
| `DSH_FLOCK_PREBUILD_DIR` | Directory holding the Bionic `system.node` + `flock.js` (default `~/.dsh/flock`) | `flock/install-android-flock.sh` |
| `DSH_VERSION` | dsh version to install (default `0.1.5-rc.1`) | `provision.sh` |
| `PREFIX` | Termux prefix (default derived from `$HOME`) | any script |
| `BROWSER_TOOLS_PYTHONPATH`, `BROWSER_USER_DATA`, `BROWSER_PROFILE_SUBSTR` | Browser tooling overrides | browser/ scripts |
| `SEARXNG_URL` | Local searXNG endpoint for web-tools (default `http://127.0.0.1:8888`) | mcp-web-tools/server.mjs |

## Single-owner contract

`provision.sh` is the BASE layer (deps, node-gyp patch, pinned install, launcher
wrapper, dispatch, `--with-local-patches` hook). The version patchers
(`patches/<ver>/`) are the SINGLE OWNER of package-level patches (sharp, flock,
hard-link→rename). Do not add a package fix to both — the patcher wins.
