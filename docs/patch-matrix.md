# Android compatibility

The installer targets DSH **0.2.1-alpha.1**. Its published dependency ranges
currently resolve the file-writing, conversation-storage, search, and
attachment packages to **0.2.1-alpha.1**, and `node-addon-system` to **0.1.2**.
The patcher checks these versions and the code it will change before writing.
An unfamiliar version or code layout is an error, not a successful repair.

| Feature | Android fix |
|---|---|
| Terminal commands | Build DSH's supplied `node-pty` using the headers installed by Termux. An existing build cache is not needed. |
| Images | Install `@img/sharp-wasm32` at the same version as DSH's `sharp` package. |
| FFI runtime | Replace DSH's pinned `koffi` (3.1.1) with 3.3.2, which ships an Android ARM64 prebuild; the pinned version's source does not compile on Termux. |
| Conversation locking | Load the included Android library. Missing or broken locking support is an error. |
| Saving conversations and creating files | Use `renameat2(RENAME_NOREPLACE)`, which publishes a file without replacing one created by another process. |
| Attachments | Stop the durability walk below the filesystem root, at the first ancestor Termux cannot open, and publish without hard links. |
| File search | Use Termux's `ripgrep`, resolved inside DSH's memoized `resolveRgPath()` factory before the packaged `@vscode/ripgrep` fallback. DSH's bundled search library does not provide an Android executable. |
| Starting DSH | Pass the Node.js option required by DSH's reload support. |

Android's app sandbox makes `/data` and `/data/data` traverse-only, so a
process may pass through them but never open them. The other fixes above swap
one system call for another; attachments cannot, because the failing step is
an unopenable directory rather than a denied operation. The storage walk
therefore stops at the highest ancestor that can be opened and verified,
which is Android's own app directory, `com.termux`. No durability is lost:
everything above that boundary belongs to the system and does not change.
Hard links are denied to the app domain, so a newly staged object is moved
into place and an already-published object is copied, preserving its original
name.

DSH supplies its own JavaScript dependencies, including `node-pty`, `koffi`,
and `sharp`; they do not need separate global installations. The installer
adds the Android packages and compatible image and file support they need.
It does not require the full native image-processing package `libvips`.

Package downloads can change over time even when the main DSH version stays
the same. This repository rejects untested patch targets rather than
assuming they are compatible. Updating support requires checking the new
packages and running the development checks again.

`DSH_ROOT` selects an installation for the patch and verification scripts.
The normal installer obtains it from `npm root -g`. Advanced users can
set `DSH_FLOCK_PREBUILD_DIR` to choose a different native-library directory;
the same variable must then be set whenever DSH runs. The default is
`$HOME/.dsh/flock`.
