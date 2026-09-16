# dsh-termux-core

Run [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (dsh) on
**Termux / Android**. This repo targets **dsh 0.1.5-rc.1** on **android-arm64**.

One script installs dsh, and re-running the same script updates it — every
Termux fix is applied and re-applied automatically.

Nothing in this repo is host-specific: no keys, no tokens, no personal config.
Your own tweaks go in a local file you pass at install time (see below).

## Prerequisites

- Termux on Android 11+ (API 30). ARM64 is the only tested/prebuilt arch
  (the flock `system.node` is android-arm64).
- `provision.sh` installs everything else itself — build tools, git, and the
  dsh package. You only need `pkg install -y git` up front so you can clone
  the repo.

## Quick start

```bash
# On a fresh Termux (Android 11+ / API 30+, arm64)
pkg install -y git
git clone https://github.com/tkosub/dsh-termux-core.git
cd dsh-termux-core
bash provision.sh
```

That's it. After it finishes you have a working `dsh 0.1.5-rc.1` on your phone
(installing the pinned version, the native add-ons, and every Termux fix).

Point dsh at your model provider (export `DEEPSEEK_API_KEY=...` or set it in
the web UI's Models page), then start the server.

## Update (same script)

```bash
cd dsh-termux-core
git pull
bash provision.sh          # re-checks the installed version, re-applies all patches
```

`provision.sh` detects what's installed, reinstalls only when the pinned
version differs, and re-applies every Termux fix (each patcher is idempotent —
safe to re-run). Add `--force` to force a clean reinstall from npm.

## What you get

`provision.sh` installs the pinned `@deepseek-ai/dsh@0.1.5-rc.1` and re-applies
each Termux fix on every run:

- **sharp** — no native android-arm64 build exists; installs the WASM runtime
  so image handling works.
- **flock** — dsh's session-write lease needs a native `flock`, but the
  upstream package supports only linux/darwin. Ships a prebuilt Bionic
  `system.node` + an android-aware loader (this unblocks dsh on Termux
  entirely).
- **hard-link → rename** — Android SELinux blocks hard links in
  app-private storage, which breaks session writes and new-file writes.
  These are switched to `rename()`.

It also fixes node-gyp for building native add-ons (node-pty) and wraps the
launcher so dsh can run with `--expose-internals` (required for HMR).

## The browser backend

A real headless browser on Termux, exposed as MCP tools:

- `chromium-proot-launcher` forwards Chromium args into a proot-distro Debian
  rootfs (there is no native Android Chromium package for Termux).
- `browse.py` (nodriver + stealth flags) renders a page to JSON — title,
  visible text, optional screenshot — with a warm shared profile to clear
  Cloudflare.
- `proot_reap.py` reaps ONLY the Chromium/proot tree matching the profile
  substring (never a broad-kill).
- `mcp-web-tools/server.mjs` adds `searxng_search` / `extract` / `fetch_raw`
  against your own local searXNG instance.

Setup + env vars: `browser/README.md`.

## Adding your own host-specific patches

The repo is deliberately free of host-specific glue. Put yours in a separate
file and point at it:

```bash
bash provision.sh --with-local-patches ~/dsh-local-patches.sh
```

Your file runs after all public patches, so it can override anything. It's a
natural place for bridges, relays, model config, or profile tweaks that would
break a stranger's phone. See `patches/local-patches.d/README.md` for guidance.

## Layout

```
dsh-termux-core/
├─ provision.sh              # install OR update (pinned 0.1.5-rc.1, idempotent)
├─ patches/
│  ├─ 0.1.5/                 # 0.1.5-rc.1 patcher (sharp + flock + hard-link→rename)
│  │  └─ dsh-fs-local-link-rename.patch
│  └─ local-patches.d/       # documented --with-local-patches hook
├─ flock/                    # Bionic flock addon for Termux
│  ├─ src/ build/ lib/       # C source, binding.gyp, android-aware loader
│  ├─ prebuilt/system.node   # Bionic/android-arm64 compiled addon
│  ├─ tests/                 # flock tests (incl. flock-load-smoke.mjs)
│  └─ install-android-flock.sh
├─ browser/                  # headless Chromium (proot) + MCP tools
├─ mcp-web-tools/            # searxng/trafilatura MCP server
└─ docs/
   ├─ patch-matrix.md        # every fix, what it does, where it's applied
   └─ upgrade-runbook.md     # upgrade + verification steps
```

## Documentation

- `docs/patch-matrix.md` — every Termux/Android fix, what it does, and where
  it's applied.
- `docs/upgrade-runbook.md` — the upgrade sequence + how to verify a working
  install.

## Related project

- [ErEbusE/dsh-termux](https://github.com/ErEbusE/dsh-termux) — the source of
  the `dsh-fs-local` hard-link→rename fix adopted here (MIT, attributed in
  `patches/0.1.5/dsh-fs-local-link-rename.patch`).

## License

MIT.
