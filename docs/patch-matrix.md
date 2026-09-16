# Android compatibility

The installer targets DSH **0.1.5-rc.1**. Its published dependency ranges
currently resolve the file-writing, conversation-storage, and search
packages to **0.1.5-rc.2**, and `node-addon-system` to **0.1.2**.
The patcher checks these versions and the code it will change before writing.
An unfamiliar version or code layout is an error, not a successful repair.

| Feature | Android fix |
|---|---|
| Terminal commands | Build DSH's supplied `node-pty` using the headers installed by Termux. An existing build cache is not needed. |
| Images | Install `@img/sharp-wasm32` at the same version as DSH's `sharp` package. |
| Conversation locking | Load the included Android library. Missing or broken locking support is an error. |
| Saving conversations and creating files | Use `renameat2(RENAME_NOREPLACE)`, which publishes a file without replacing one created by another process. |
| File search | Use Termux's `ripgrep`. DSH's bundled search library does not provide an Android executable. |
| Starting DSH | Pass the Node.js option required by DSH's reload support. |

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
