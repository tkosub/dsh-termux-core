# Android file support

This directory provides two operations needed by DSH on Android:

- Exclusive file locking, so two processes cannot write the same
  conversation at once.
- Atomic file creation that refuses to replace an existing destination.

The second operation uses `renameat2(RENAME_NOREPLACE)`. Ordinary
`rename()` can overwrite a concurrent creator's file and is not a substitute.
If the kernel or filesystem cannot perform the operation, it fails.
Missing native support never becomes a simulated lock or an unsafe rename.

## Build

On an ARM64 Termux installation with Node.js and clang installed:

```bash
bash flock/build.sh
cd flock/prebuilt
sha256sum system.node > SHA256SUMS
```

The build uses Termux's Node.js headers and Node-API version 8. No downloaded
Node.js headers or Android NDK installation is needed. The shipped binary's
checksum is in `prebuilt/SHA256SUMS`; the installer verifies it before copying.
The checksum detects corruption, not an untrusted repository modification.

## Test

From the repository root on Android:

```bash
DSH_FLOCK_TEST_BINDING="$PWD/flock/prebuilt/system.node" node flock/tests/test-flock-addon.cjs
DSH_FLOCK_PREBUILD_DIR="$PWD/flock/prebuilt" node flock/tests/flock-load-smoke.mjs
```

The first test asserts that a second process is refused while a lock is
held and succeeds after release. The installer also tests file creation
and collision handling through the installed loader.

`src/flock.c` includes upstream file-locking code and the added file-publication
operation. See `UPSTREAM-LICENSE` and the repository's `NOTICE`.
