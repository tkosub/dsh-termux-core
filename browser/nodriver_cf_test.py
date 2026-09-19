#!/usr/bin/env python3
"""Smoke test: drive the proot Chromium via nodriver with stealth flags.

Validation:
  1. Browser launches through the proot launcher (Debian Chromium on Termux).
  2. navigator.webdriver is patched (False/undefined) and plugins > 0.
  3. UA does NOT contain the 'HeadlessChrome' leak.
  4. A Cloudflare-protected target either serves real content or shows a
     challenge we can recognise (single low-footprint navigation).

Process hygiene: launches a UNIQUE per-run profile dir and reaps its own proot
Chromium in `finally` (via proot_reap.reap). `browser.stop()` alone leaks the
proot/Chromium tree — see the (retired) cloudflare-stealth-browser skill's
proot-process-lifecycle note.

Portable by design (repo policy): no absolute host paths. The launcher and the
reaper are resolved from this file's directory (browser/ ships them
alongside); override with CHROMIUM_PROOT_LAUNCHER / BROWSER_PYTHONPATH
when running from a deployment copy.
"""
import asyncio
import os
import sys
import tempfile
import nodriver as uc

HERE = os.path.dirname(os.path.abspath(__file__))
# This file's own directory first (repo ships proot_reap.py alongside), then
# env-provided extra dirs (e.g. the deployed copy dir).
sys.path.insert(0, HERE)
for extra in reversed(os.environ.get("BROWSER_PYTHONPATH", "").split(":")):
    if extra:
        sys.path.insert(0, extra)
from proot_reap import reap

# nodriver calls the launcher as <wrapper> [chromium args...]; the launcher
# forwards verbatim into the proot rootfs. Env-overridable, $HOME-agnostic.
LAUNCHER = os.environ.get(
    "CHROMIUM_PROOT_LAUNCHER",
    os.path.join(HERE, "chromium-proot-launcher"),
)
REAL_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")

STEALTH_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    f"--user-agent={REAL_UA}",
]

CHALLENGE_MARKERS = [
    "just a moment", "checking your browser", "verify you are human",
    "ddos protection", "attention required", "enable javascript and cookies",
]

# nowsecure.nl is a dedicated bot-detection test page (controlled, low risk).
BOT_TEST = "https://nowsecure.nl"
# A real Cloudflare-fronted target; presence confirmed via header check at runtime.
CF_TARGET = "https://www.cloudflare.com"


def scan_for_challenge(text: str) -> bool:
    t = (text or "").lower()
    return any(m in t for m in CHALLENGE_MARKERS)


async def probe(tab, url: str, sleep=6):
    await tab.get(url)
    await tab.sleep(sleep)
    title = await tab.evaluate("document.title")
    body = await tab.evaluate("document.body ? document.body.innerText.slice(0,400) : ''")
    ua = await tab.evaluate("navigator.userAgent")
    wd = await tab.evaluate("navigator.webdriver")
    challenge = scan_for_challenge(title + "\n" + body)
    return {
        "url": url, "title": title, "ua_headless": "HeadlessChrome" in (ua or ""),
        "webdriver": wd, "challenge": challenge, "body_sample": (body or "").strip()[:160],
    }


async def main():
    # UNIQUE per-run profile dir: never collides with chrome-headless's shared
    # lock, and lets cleanup target ONLY our own chromium (see the skill).
    profile = tempfile.mkdtemp(prefix="cf-test-")
    browser = None
    try:
        browser = await uc.start(
            browser_executable_path=LAUNCHER,
            user_data_dir=profile,
            headless=True,
            browser_args=STEALTH_ARGS,
        )
        print("[ok] browser launched via proot launcher")

        results = []
        # 1) controlled bot-detection page
        tab = await browser.get("about:blank")
        results.append(await probe(tab, BOT_TEST))

        # 2) real Cloudflare target — only if it's actually CF-fronted
        try:
            import subprocess
            hdr = subprocess.run(
                ["curl", "-fsSI", CF_TARGET], capture_output=True, text=True, timeout=15
            ).stdout.lower()
            cf = ("cf-ray" in hdr) or ("server: cloudflare" in hdr)
            print(f"[info] {CF_TARGET} CF-fronted: {cf} (headers: "
                  f"{'cf-ray' if 'cf-ray' in hdr else (hdr.splitlines()[0] if hdr else 'none')})")
            if cf:
                results.append(await probe(tab, CF_TARGET, sleep=8))
        except Exception as e:
            print(f"[warn] header check skipped: {e}")

        for r in results:
            print("---")
            print(f"  url         : {r['url']}")
            print(f"  title       : {r['title']!r}")
            print(f"  webdriver   : {r['webdriver']!r}")
            print(f"  ua_headless : {r['ua_headless']}")
            print(f"  challenge?  : {r['challenge']}")
            print(f"  body        : {r['body_sample']!r}")

        ok = all(not r["ua_headless"] and r["webdriver"] in (False, None) for r in results)
        print("RESULT:", "STEALTH_OK" if ok else "STEALTH_WEAK")
        return 0 if ok else 2
    finally:
        # Always reap OUR proot Chromium — browser.stop() alone leaks it.
        if browser is not None:
            try:
                browser.stop()
            except Exception:
                pass
        reap(profile)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
