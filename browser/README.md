# Browser backend (proot Chromium + MCP tools)

A self-contained Termux/Android browser backend: a launcher that runs the
Debian Chromium inside a `proot-distro` rootfs, a stealth wrapper around
`nodriver`, a targeted process reaper, and two MCP stdio servers that expose
the stack to the agent.

Nothing here contains host-specific paths or identity. All file locations are
either relative to this directory or configurable via environment variables.

## What you get

| File | Purpose |
|---|---|
| `chromium-proot-launcher` | Forwards Chromium args into a `proot-distro` Debian rootfs (nodriver spawns this as the executable). |
| `stealth_browser.py` | `nodriver` wrapper: anti-Cloudflare flags + warm shared profile. |
| `browse.py` | One-shot page render to JSON (title + visible text + optional screenshot); called by the MCP server. |
| `proot_reap.py` | Reaps ONLY the Chromium/proot tree whose `--user-data-dir` matches a substring (never an unfiltered `pkill`). |
| `server.mjs` | MCP stdio server exposing `browse` (JS-rendered page text + screenshot). |
| `../mcp-web-tools/server.mjs` | MCP stdio server exposing `searxng_search`, `extract` (trafilatura), `fetch_raw` (curl). |

## Prerequisites (Termux)

```bash
pkg install -y proot-distro python nodejs
proot-distro install debian
proot-distro login debian -- apt-get update
proot-distro login debian -- apt-get install -y chromium
pip install nodriver        # in the python that will run browse.py
```

`browse.py` and `server.mjs` also need `curl` (web-tools) and the stealth
prereqs above.

**Co-location requirement:** `browse.py` imports `stealth_browser` and
`proot_reap` from its own directory first, and `server.mjs` resolves
`browse.py` relative to its own module directory. So `browse.py`,
`stealth_browser.py`, `proot_reap.py` and `server.mjs` MUST live in the same
directory (or you must set `BROWSER_TOOLS_BROWSE` / `BROWSER_TOOLS_PYTHONPATH`
to point at them explicitly).

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `PYTHON3` | `python3` | Python interpreter for `browse.py` |
| `BROWSER_TOOLS_BROWSE` | `./browse.py` (next to `server.mjs`) | Path to the browse script |
| `BROWSER_TOOLS_PYTHONPATH` | — | Extra `:`-separated dirs to import `stealth_browser`/`proot_reap` from |
| `BROWSER_USER_DATA` | `~/.cache/browser-tools/user-data` | Shared warm Chromium profile dir |
| `BROWSER_PROFILE_SUBSTR` | `browser-tools/user-data` | Substring used to reap the proot tree |
| `CHROMIUM_PROOT_LAUNCHER` | `~/bin/chromium-proot-launcher` | Launcher path for `stealth_browser.py` |
| `PROOT_DISTRO` / `PROOT_CHROMIUM` | `debian` / `/usr/lib/chromium/chromium` | proot rootfs + binary for the launcher |
| `SEARXNG_URL` (web-tools) | `http://127.0.0.1:8888` | URL of a private searXNG instance |

## Booking a screenshot

```bash
python3 browse.py --url https://example.com --screenshot /tmp/shot.png
python3 browse.py --url https://example.com --wait-ms 5000 --max-chars 40000
```
JSON result on stdout: `{"ok":true,"url":...,"title":...,"text":...,"screenshot_path":...}`.

## Cautions

- **Serialize calls.** Chromium locks the shared user-data dir; the MCP server
  serializes internally, but don't run two `browse.py` concurrently.
- **Do not broad-kill.** The reaper is deliberate — it matches a specific
  `--user-data-dir` substring and excludes its own process ancestry. Never
  replace it with a blanket `pkill -f chromium` (that also takes down other
  proot users on the device).
- **Rootfs changes.** If you change `PROOT_DISTRO` or the Chromium binary,
  bump `BROWSER_PROFILE_SUBSTR`/`BROWSER_USER_DATA` so reaping still targets
  the right tree.
