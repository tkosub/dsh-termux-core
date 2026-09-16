#!/usr/bin/env python3
"""Targeted proot-Chromium reaper for Termux/Android stealth-browser scripts.

Reaps ONLY the Chromium/proot tree whose --user-data-dir contains the given
substring. IMPORTANT: the standalone form below (`python proot_reap.py <substr>`)
matches its own argv via `pgrep -f`, so `reap()` excludes the caller and its
ancestor chain before signalling — do not add an unfiltered `pkill`/SIGKILL path.

Import and call in `finally` AFTER `browser.stop()`:

    from proot_reap import reap
    reap("browser-tools/user-data")   # your unique --user-data-dir substring

Runnable standalone for a one-off reap:
    python proot_reap.py browser-tools/user-data
"""
import os
import signal
import subprocess
import sys


def _ancestors(pid: int) -> set[int]:
    """Return pid and every ancestor up the PPID chain."""
    chain: set[int] = set()
    cur = pid
    for _ in range(20):
        if cur <= 1 or cur in chain:
            break
        chain.add(cur)
        try:
            with open(f"/proc/{cur}/status") as fh:
                for line in fh:
                    if line.startswith("PPid:"):
                        cur = int(line.split()[1])
                        break
        except OSError:
            break
    return chain


def reap(profile_substr: str) -> None:
    """SIGKILL every process whose argv contains profile_substr.

    Excludes the caller and its ancestor chain, so the standalone
    `python proot_reap.py <substr>` form no longer SIGKILLs its own launcher.
    """
    protected = _ancestors(os.getpid())
    try:
        out = subprocess.run(
            ["pgrep", "-f", profile_substr],
            capture_output=True, text=True,
        ).stdout.split()
    except Exception:
        return
    for pid in out:
        try:
            ip = int(pid)
        except ValueError:
            continue
        if ip in protected:
            continue
        try:
            os.kill(ip, signal.SIGKILL)
        except Exception:
            pass


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: proot_reap.py <profile_substr>")
        sys.exit(2)
    reap(sys.argv[1])
