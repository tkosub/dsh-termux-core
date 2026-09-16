#!/usr/bin/env python3
"""browse.py — render a page with the proot Debian Chromium via nodriver.

Called by the mcp browser-tools server (one process per call). Outputs exactly
one line of JSON on stdout:
  {"ok":true,"url":"...","title":"...","text":"...","screenshot_path":"...","elapsed_ms":N}
or {"ok":false,"error":"..."}

Uses a SHARED warm profile (default ~/.cache/browser-tools/user-data) so
Cloudflare clearance cookies survive across calls. The caller must serialize
calls (Chromium locks the user-data-dir). Reaps the proot tree in finally.

Environment (all optional; defaults are $HOME-relative, no absolute paths):
  BROWSER_TOOLS_PYTHONPATH  colon-separated extra dirs to import
                            stealth_browser / proot_reap from (in addition to
                            this file's own directory)
  BROWSER_USER_DATA         Chromium profile dir (default ~/.cache/browser-tools/user-data)
  BROWSER_PROFILE_SUBSTR    substring used to reap the proot tree afterwards;
                            must match the --user-data-dir value actually used
                            (default "browser-tools/user-data")
"""
import argparse
import asyncio
import json
import os
import sys
import time

# Load helpers from this file's directory first (the repo ships
# stealth_browser.py + proot_reap.py alongside), then any env-provided dirs.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
for extra in reversed(os.environ.get("BROWSER_TOOLS_PYTHONPATH", "").split(":")):
    if extra:
        sys.path.insert(0, extra)
import nodriver as uc
from stealth_browser import USER_DATA, stealth_start
from proot_reap import reap

PROFILE_SUBSTR = os.environ.get("BROWSER_PROFILE_SUBSTR") or "browser-tools/user-data"


async def run(args):
    t0 = time.monotonic()
    browser = None
    try:
        browser = await asyncio.wait_for(
            stealth_start(headless=True),
            timeout=args.timeout,
        )
        tab = await asyncio.wait_for(browser.get(args.url), timeout=args.timeout)
        await tab.sleep(max(0, args.wait_ms) / 1000.0)
        title = await tab.evaluate("document.title")
        text = await tab.evaluate(
            "(document.body ? document.body.innerText : '') || ''")
        if isinstance(text, str) and len(text) > args.max_chars:
            text = text[: args.max_chars] + f"\n\n[truncated at {args.max_chars} chars]"
        out = {
            "ok": True,
            "url": args.url,
            "title": title if isinstance(title, str) else "",
            "text": text if isinstance(text, str) else "",
            "elapsed_ms": int((time.monotonic() - t0) * 1000),
        }
        if args.screenshot:
            try:
                saved = await tab.save_screenshot(args.screenshot)
                out["screenshot_path"] = saved if isinstance(saved, str) else args.screenshot
            except Exception as e:  # screenshot is best-effort
                out["screenshot_error"] = str(e)
        return out
    except Exception as e:
        return {"ok": False, "url": args.url, "error": str(e),
                "elapsed_ms": int((time.monotonic() - t0) * 1000)}
    finally:
        if browser is not None:
            try:
                browser.stop()
            except Exception:
                pass
        try:
            reap(PROFILE_SUBSTR)
        except Exception:
            pass


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True)
    p.add_argument("--wait-ms", type=int, default=3500)
    p.add_argument("--timeout", type=int, default=60)
    p.add_argument("--max-chars", type=int, default=20000)
    p.add_argument("--screenshot", default=None)
    args = p.parse_args()
    result = asyncio.run(run(args))
    sys.stdout.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
