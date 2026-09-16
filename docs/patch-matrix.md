# Patch matrix — dsh on Termux/Android

Every Termux/Android incompatibility this repo fixes, what it does, and where
it is applied. Targets dsh 0.1.5-rc.1 on android-arm64 (Termux).

## The fixes

| Fix | What it does | Where it's applied |
|---|---|---|
| F1. sharp WASM fallback | `android-arm64` has no native sharp prebuilt; installs the `@img/sharp-wasm32` runtime so image handling works. Re-applied whenever sharp is reinstalled/updated. | `patches/0.1.5/dsh-apply-015-patches.sh` (leg 1) |
| F2. flock addon | dsh's session-write lease needs a native `flock`; upstream ships only linux/darwin, which breaks dsh on Android. Installs a prebuilt Bionic `system.node` + android-aware loader. Re-check loader/file shapes on each upgrade. | `flock/install-android-flock.sh` (+ patcher leg 2) |
| F3. session-writer hard-link→rename | Android SELinux blocks `link()` in app-private storage (f2fs); switches session-write publication from `link()` to `rename()`. Re-check no `link(` publish remains after install. | `dsh-session-persistence-jsonl/lib/index.js` (patcher leg 3) |
| F4. agent-write hard-link→rename | Same SELinux hard-link block breaks the agent `write` tool for new files. Adopted from ErEbusE/dsh-termux (MIT). Re-apply after each upgrade. | `dsh-fs-local/lib/index.js` via `patches/0.1.5/dsh-fs-local-link-rename.patch` (patcher leg 4) |
| F5. node-gyp `android_ndk_path` | node-gyp's android branch references an undefined variable, breaking the node-pty native build; defines it against the Termux sysroot. Re-applied whenever node-gyp is (re)installed. | `~/.cache/node-gyp/<ver>/include/node/common.gypi` (provision.sh) |
| F6. launcher wrapper `--expose-internals` | dsh's HMR plugin requires `--expose-internals`; `NODE_OPTIONS` forbids it, so dsh is invoked through a wrapper that passes the flag. | `$PREFIX/bin/dsh` → launcher wrapper (provision.sh) |

## Environment variables

| Variable | Meaning | Set by |
|---|---|---|
| `DSH_FLOCK_PREBUILD_DIR` | Directory holding the Bionic `system.node` + loader (default `~/.dsh/flock`) | `flock/install-android-flock.sh` |
| `DSH_VERSION` | dsh version to install (default `0.1.5-rc.1`) | `provision.sh` |
| `PREFIX` | Termux prefix (default derived from `$HOME`) | any script |
| `BROWSER_TOOLS_PYTHONPATH`, `BROWSER_USER_DATA`, `BROWSER_PROFILE_SUBSTR` | Browser tooling overrides | browser/ scripts |
| `SEARXNG_URL` | Local searXNG endpoint for web-tools (default `http://127.0.0.1:8888`) | mcp-web-tools/server.mjs |

The version patcher (`patches/0.1.5/dsh-apply-015-patches.sh`) applies the
package-level fixes (F1–F4); `provision.sh` is the base layer that applies F5,
F6, and dispatches the patcher (F1–F4). Your personal tweaks run last via
`--with-local-patches` (see `patches/local-patches.d/README.md`).
