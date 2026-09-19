# Browser backend (proot Chromium + MCP tools)

A self-contained Termux/Android browser backend: a launcher that runs the
Debian Chromium inside a `proot-distro` rootfs, a stealth wrapper around
`nodriver`, a targeted process reaper, and one MCP stdio server exposing the
stack to the agent as four tools.

Nothing here contains host-specific paths or identity. All file locations are
either relative to this directory or configurable via environment variables.
The launcher uses `#!/bin/sh` (a fixed Android path) so no Termux-absolute
path appears anywhere.

## What you get

One MCP server (`serverName: browser`) with four tools:

| Tool | Purpose |
|---|---|
| `browse` | One-shot page render (title + visible text + optional screenshot). Reuses a live session if one is open, else boots → renders → **closes immediately**. |
| `open` | Open a URL in the shared session (boots the browser; returns rendered text). |
| `act` | Run interaction steps against the live page (click/type/drag/scroll/read/eval/screenshot/wait/navigate/press). |
| `close` | Stop the browser and reap its process tree. **Call when a browse is done** — idle auto-retire (10 min) is only a backstop. |

| File | Purpose |
|---|---|
| `chromium-proot-launcher` | Forwards Chromium args into a `proot-distro` Debian rootfs (nodriver spawns this as the executable). |
| `stealth_browser.py` | `nodriver` wrapper: anti-Cloudflare flags + session profile. |
| `session_serve.py` | Long-lived actor owning ONE proot Chromium tab (newline-JSON over stdio). |
| `session_server.mjs` | MCP stdio server: `browse` / `open` / `act` / `close`, idle-retire timer, orphan-safe teardown. |
| `proot_reap.py` | Reaps ONLY the Chromium/proot tree whose `--user-data-dir` matches a substring (never an unfiltered `pkill`). |
| `nodriver_cf_test.py` | Smoke test: launches the backend, checks stealth flags, probes a bot-detection page and a Cloudflare target; exit 0 = STEALTH_OK. |
| `../mcp-web-tools/server.mjs` | MCP stdio server exposing `searxng_search`, `extract` (trafilatura), `fetch_raw` (curl). |

## Install (recommended)

`bash provision.sh --with-web-tools` (from the repository root) installs the
prerequisites, the Debian proot rootfs with Chromium, `nodriver` + `trafilatura`
in the Termux system Python, then copies this whole `browser/` directory into
`~/.dsh/mcp/browser-session/` and `mcp-web-tools/server.mjs` into
`~/.dsh/mcp/web-tools/`. Re-running the flag refreshes the deployed copies
from the repository — the live files are a deployment, not an independent
source. To host the stack elsewhere instead, follow the manual steps below.

## Prerequisites (Termux)

```bash
pkg install -y proot-distro python nodejs
proot-distro install debian
proot-distro login debian -- apt-get update
proot-distro login debian -- apt-get install -y chromium
pip install nodriver        # in the python that will run session_serve.py
```

`session_serve.py` and `session_server.mjs` also need `proot-distro` on PATH
(web-tools needs `curl`).

**Co-location requirement:** `session_serve.py` imports `stealth_browser` and
`proot_reap` from its own directory, and `session_server.mjs` resolves
`session_serve.py` relative to its own module directory. So
`session_serve.py`, `stealth_browser.py`, `proot_reap.py`,
`chromium-proot-launcher` and `session_server.mjs` MUST live in the same
directory. The smoke test `nodriver_cf_test.py` resolves the launcher and
reaper from its own directory the same way.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `PYTHON3` | `python3` | Python interpreter for `session_serve.py` |
| `BROWSER_SESSION_SERVE` | `./session_serve.py` (next to `session_server.mjs`) | Path to the actor |
| `BROWSER_PYTHONPATH` | — | Extra `:`-separated dirs to import `stealth_browser`/`proot_reap` from |
| `BROWSER_SESSION_USER_DATA` | `~/.cache/browser-session/user-data` | Chromium profile dir for the session/one-shot browser |
| `BROWSER_SESSION_PROFILE_SUBSTR` | `browser-session/user-data` | Substring used to reap the proot tree; must match the dir actually used |
| `BROWSER_USER_DATA` | `~/.cache/browser-session/user-data` | Default profile in `stealth_browser.py` (overridden by `BROWSER_SESSION_USER_DATA` in the actor) |
| `CHROMIUM_PROOT_LAUNCHER` | the `chromium-proot-launcher` next to the importing file | Launcher path for `stealth_browser.py` |
| `PROOT_DISTRO` / `PROOT_CHROMIUM` | `debian` / `/usr/lib/chromium/chromium` | proot rootfs + binary for the launcher |
| `SEARXNG_URL` (web-tools) | `http://127.0.0.1:8888` | URL of a private searXNG instance |

## Standalone checks

```bash
python3 nodriver_cf_test.py   # smoke test (exit 0 = STEALTH_OK)
```

`session_serve.py` is a stdio protocol server, not a CLI — drive it through
`session_server.mjs` via MCP `tools/call` (or `browse` for a one-shot render).

## Cautions

- **Serialize calls.** Chromium locks the shared user-data dir; the MCP server
  serializes internally, but don't run two browser sessions concurrently
  against the same profile.
- **Close when done.** `close` releases Chromium immediately; idle auto-retire
  (10 min) is a backstop, not the intended teardown path.
- **Do not broad-kill.** The reaper is deliberate — it matches a specific
  `--user-data-dir` substring and excludes its own process ancestry. Never
  replace it with a blanket `pkill -f chromium` (that also takes down other
  proot users on the device).
- **Rootfs changes.** If you change `PROOT_DISTRO` or the Chromium binary,
  bump `BROWSER_SESSION_USER_DATA`/`BROWSER_SESSION_PROFILE_SUBSTR` so reaping
  still targets the right tree.
