#!/usr/bin/env python3
"""stealth_browser — nodriver + proot Chromium stealth wrapper for Termux/Android.

Drives the Debian Chromium inside a proot-distro rootfs through nodriver with
anti-Cloudflare flags. Zero-cost (no paid proxy/API needed); uses the device's
own residential mobile-data IP when no proxy is set.

Requires:
  - a proot-distro Debian install containing Chromium
  - browser/chromium-proot-launcher (forwards args into proot-distro)
  - nodriver pip-installed in the active venv

Environment (all optional; defaults are $HOME-relative, no absolute paths):
  CHROMIUM_PROOT_LAUNCHER  path to the launcher (default ~/bin/chromium-proot-launcher)
  BROWSER_USER_DATA        Chromium profile dir (default ~/.cache/browser-tools/user-data)

Usage:
  from stealth_browser import stealth_start, get_stealth_args
  browser = await stealth_start()
  tab = await browser.get("https://some-cf-site.example")
"""
import os
import nodriver as uc

LAUNCHER = os.environ.get(
    "CHROMIUM_PROOT_LAUNCHER",
    os.path.join(os.path.expanduser("~"), "bin", "chromium-proot-launcher"),
)
USER_DATA = os.environ.get(
    "BROWSER_USER_DATA",
    os.path.join(os.path.expanduser("~"), ".cache", "browser-tools", "user-data"),
)
REAL_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")


def get_stealth_args(extra=None):
    args = [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        f"--user-agent={REAL_UA}",
    ]
    if extra:
        args.extend(extra)
    return args


async def stealth_start(headless=True, extra_args=None, user_data_dir=USER_DATA):
    return await uc.start(
        browser_executable_path=LAUNCHER,
        user_data_dir=user_data_dir,
        headless=headless,
        browser_args=get_stealth_args(extra_args),
    )
