# flock — Bionic flock addon for dsh on Termux/Android

The `@deepseek-ai/dsh` session-write lease (dsh ≥ 0.1.5) uses
`@deepseek-ai/node-addon-system/flock`. The upstream `flock.js` loader admits
only `linux`/`darwin` and throws `ERR_FLOCK_UNSUPPORTED_PLATFORM` on Android
(Termux) because per-platform npm packages exist only for darwin+linux. But
Android's Bionic libc exposes a fully functional `flock(2)` — so this package
ships:

- a **prebuilt** `system.node` for `android-arm64` (Bionic), a Node-API addon
  that wraps asynchronous `flock(LOCK_EX | LOCK_NB)` (see `src/flock.c`);
- an **android-aware loader** `lib/flock.js` that admits `android`, loads the
  prebuilt from the host-controlled directory, and is a byte-compatible
  drop-in for `node-addon-system/lib/flock.js`.

This is the piece that unblocks dsh 0.1.5+ on Termux (the "flock blocker").

## Layout

```
flock/
  lib/flock.js            android-aware loader (drop-in for the upstream file)
  lib/flock.js.orig       upstream loader, for reference / diffing
  src/flock.c             vendored addon source (unmodified upstream)
  src/main.c              vendored source (packaged with the entry, unused for flock)
  build/binding.gyp       node-gyp config used to compile system.node
  prebuilt/system.node    compiled Bionic android-arm64 binding (11504 bytes)
  tests/
    test-flock-addon.cjs  cross-process functional test (self-contained)
    a-path-smoke.mjs      loader smoke test (uses the env prebuild dir)
  install-android-flock.sh  installer (idempotent, PREFIX-derived)
```

## How it works

The loader's `loadBinding()` relaxes the upstream platform guard to admit
`android`, then resolves the prebuilt at `$DSH_FLOCK_PREBUILD_DIR/system.node`
(default `~/.dsh/flock/`). If the prebuilt is absent it falls back to a
single-process no-op lease — **loudly**: it warns once on stderr with code
`DSH_FLOCK_NO_PREBUILD` so a missing prebuilt is never silent (a silent no-op
would recreate the exact failure mode that blocked dsh 0.1.5, two processes
both believing they hold the lock). A properly provisioned host never sees the
warning.

The loader never hard-codes a host path: the store directory comes from
`DSH_FLOCK_PREBUILD_DIR` (or `$HOME`), so the same file works on any Termux
device.

## Install

```sh
bash flock/install-android-flock.sh
```

That copies `prebuilt/system.node` to `$DSH_FLOCK_PREBUILD_DIR` (default
`~/.dsh/flock/`) and replaces the live
`@deepseek-ai/node-addon-system/lib/flock.js` in the installed dsh tree with
the android-aware loader. Run it again after any dsh upgrade that replaces
`node-addon-system`.

## Test

```sh
# functional cross-process test (uses the prebuilt)
DSH_FLOCK_TEST_BINDING="$PWD/prebuilt/system.node" \
  node tests/test-flock-addon.cjs

# loader smoke test (imports the loader, acquires via env prebuild dir)
DSH_FLOCK_PREBUILD_DIR="$PWD/prebuilt" node tests/a-path-smoke.mjs
```

Expected: holder acquires, child while held returns EAGAIN, child after release
re-acquires; smoke prints `A-path OK`.

## Building the addon from source

You normally don't need to — `prebuilt/system.node` is the verified,
tested binary. To rebuild (e.g. for a different NDK/API level):

```sh
cd build && node-gyp rebuild
```

Requires the Termux `node-dev`/clang toolchain. `binding.gyp` compiles
`src/flock.c` with `-fPIC` and Node-API v8 (no C++ exceptions).

## Provenance

- `src/flock.c`, `src/main.c`: vendored unmodified from
  `@deepseek-ai/node-addon-system`.
- `prebuilt/system.node`: compiled for Bionic/android-arm64, Node-API v10,
  ABI 147 (Node 26). SHA-256:
  `81ef306f2d48b52a7682e3a0b2685a5bd608d51392198bfe59caffc32a9ba484`.
- Functional probe passed: holder acquires; a second fd returns EAGAIN
  (contention); release re-acquires.
