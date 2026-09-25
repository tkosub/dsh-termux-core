# Browser backend (proot Chromium + MCP tools)

A self-contained Termux/Android browser backend: a launcher that runs the
Debian Chromium inside a `proot-distro` rootfs, a stealth wrapper around
`nodriver`, a targeted process reaper, and one MCP stdio server exposing the
stack to the agent as five tools, gated so a browser session is an explicit act
with a declared owner (see [Session ownership](#session-ownership-the-gate)).

Nothing here contains host-specific paths or identity. All file locations are
either relative to this directory or configurable via environment variables.
The launcher uses `#!/bin/sh` (a fixed Android path) so no Termux-absolute
path appears anywhere.

## What you get

One MCP server (`serverName: browser`) with five tools:

| Tool | Purpose |
|---|---|
| `status` | Who holds the browser, and their remaining idle time. Read-only, needs no owner, starts nothing. |
| `browse` | One-shot page render (title + visible text + optional screenshot). Reuses YOUR live session if you have one, else boots → renders → **closes immediately** and releases the gate. |
| `open` | Open a URL in YOUR session (boots the browser; returns rendered text). |
| `act` | Run interaction steps against the live page (click/type/drag/scroll/read/eval/screenshot/wait/navigate/press). |
| `close` | Stop the browser and reap its process tree, releasing the gate. **Call when done** — idle auto-retire (10 min) is only a backstop. |

`browse`, `open`, `act` and `close` require `owner`. `status` does not.

| File | Purpose |
|---|---|
| `chromium-proot-launcher` | Forwards Chromium args into a `proot-distro` Debian rootfs (nodriver spawns this as the executable). Deliberately a **pass-through**: it holds no policy, so it can never lock the browser out. |
| `stealth_browser.py` | `nodriver` wrapper: anti-Cloudflare flags + session profile. |
| `session_serve.py` | Long-lived actor owning ONE proot Chromium tab (newline-JSON over stdio). |
| `session_server.mjs` | MCP stdio server: the ownership gate, `status` / `browse` / `open` / `act` / `close`, idle-retire timer, orphan-safe teardown. |
| `proot_reap.py` | Reaps ONLY the Chromium/proot tree whose `--user-data-dir` matches a substring (never an unfiltered `pkill`). |
| `test-session-gate.mjs` | Offline gate test (stub actor — no browser, no network): schemas, refusals, takeover. |
| `test-session-contention.mjs` | Real end-to-end test: boots a real Chromium, proves a second owner is refused **without a second boot**, and that closing leaves nothing running. |
| `nodriver_cf_test.py` | Smoke test: launches the backend, checks stealth flags, probes a bot-detection page and a Cloudflare target; exit 0 = STEALTH_OK. |
| `../mcp-web-tools/server.mjs` | MCP stdio server exposing `searxng_search`, `extract` (trafilatura), `fetch_raw` (curl). |

## Session ownership (the gate)

Chromium costs ~800 MB on a phone, so a browser session is an **explicit act
with a declared owner**, and exactly one may exist at a time — across every DSH
session, not merely within one.

**Why the gate is in `session_server.mjs` and not in the launcher.** The MCP
server is a runtime-global singleton (one per `dsh web` process, shared by all
sessions) and is the only path the tools have to a browser, so a refusal there
is a refusal with no bypass inside the tool surface — and it can be answered
with a structured result instead of a crashed launch. The launcher is exec'd
deep inside `proot`; nothing below the server can see the caller, and a lock
taken there is inherited by every Chromium child, so killing the browser would
NOT release it (demonstrated: a killed holder kept the lock). A gate in the
launcher is an outage generator; a gate in the server is enforcement.

Rules:

- `owner` is required on `browse`/`open`/`act`/`close`: any string naming the
  caller — a DSH session id, or a role/name inside an agent team. The server
  cannot see the caller's session id (`DSH_SESSION_ID` is injected into model
  *shell* calls only, never into MCP children), so the owner is declared, not
  inferred.
- A free gate is claimed by whoever opens first. A call whose owner is not the
  holder is refused **before any browser starts**, naming the holder and her
  session id: `{"ok":false,"refused":"held_by","held_by":"alice",…}`.
- A call with no owner is refused outright: `{"ok":false,"refused":"no_owner",…}`.
  Silence is not consent to spend memory.
- Only the owner may close. There is **no preemption and no kill path** — the
  refusal text says so, because the alternative an agent would otherwise reach
  for is `pkill`, which is forbidden on this device (see `proot_reap.py`).
- `idle_ms` is clamped to 30 s..30 min; `idle_ms: 0` no longer means "never"
  (it meant "hold the browser forever").
- `status` needs no owner, so a locked-out agent can see who holds the browser
  without booting one to find out.

The lock record lives at `$DSH_BROWSER_SESSION_RUN/browser-session.lock`
(default `~/.dsh/run/`) and carries `owner`, `pid`, `started`, `starttime`,
`session_id`. A record is honoured **only while its pid exists and its kernel
start time still matches** — the same proof discipline as the release tool — so
a crashed or SIGKILLed server can never leave the browser permanently locked,
and a recycled pid cannot impersonate a holder. The operator's escape hatch is
therefore not needed: restart `dsh` and the gate is free.

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
| `DSH_BROWSER_SESSION_RUN` | `~/.dsh/run` | Directory holding `browser-session.lock`, the single-session ownership record |
| `SEARXNG_URL` (web-tools) | `http://127.0.0.1:8888` | URL of a private searXNG instance |

## Standalone checks

```bash
node test-session-gate.mjs          # gate logic, stub actor: no browser, no network
node test-session-contention.mjs    # REAL Chromium: second owner refused, nothing leaks
python3 nodriver_cf_test.py         # smoke test (exit 0 = STEALTH_OK)
```

`session_serve.py` is a stdio protocol server, not a CLI — drive it through
`session_server.mjs` via MCP `tools/call` (or `browse` for a one-shot render).

## Cautions

- **One session, one owner.** The server refuses a second owner before starting
  anything. Chromium's own profile lock is a backstop, not the mechanism — two
  sessions sharing one profile dir were observed on this host before the gate
  existed. Agents that need the browser concurrently serialise through the gate,
  not around it.
- **Close when done.** `close` releases Chromium immediately; idle auto-retire
  (10 min) is a backstop, not the intended teardown path.
- **Do not broad-kill.** The reaper is deliberate — it matches a specific
  `--user-data-dir` substring and excludes its own process ancestry. Never
  replace it with a blanket `pkill -f chromium` (that also takes down other
  proot users on the device).
- **Rootfs changes.** If you change `PROOT_DISTRO` or the Chromium binary,
  bump `BROWSER_SESSION_USER_DATA`/`BROWSER_SESSION_PROFILE_SUBSTR` so reaping
  still targets the right tree.
