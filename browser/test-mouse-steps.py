#!/usr/bin/env python3
"""test-mouse-steps.py — offline regression test for the actor's mouse steps.

The actor's mouse steps build CDP `Input.dispatchMouseEvent` calls. Those
calls serialize the button with `button.to_json()`, so the value MUST be a
`MouseButton` enum member: a plain string raises `AttributeError: 'str'
object has no attribute 'to_json'` before anything reaches Chromium. Worse,
`do_act` treats any non-StepError as fatal and closes the session, so one bad
string takes the whole browser down rather than failing a single step.

A string is the natural-looking thing to write, and three call sites had one
(hover, drag's move, and drag's distribute helper), which is why `hover`
appeared to kill the browser.

This drives the real `do_act` against a recording stub tab — no Chromium, no
network, no display. It asserts an enum reaches CDP for every mouse step, and
that the session survives, so a future string regression fails here.

Usage: python3 test-mouse-steps.py
Exit 0 = all assertions passed.
"""

import asyncio
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import session_serve as actor


class RecordingTab:
    """Captures dispatched CDP commands without a browser."""

    def __init__(self):
        self.commands = []

    async def send(self, command):
        self.commands.append(command)
        return None

    async def get(self, url):
        return self


def _resolve(command):
    """Resolve one sent command into its CDP dict.

    nodriver's generated commands are generators that yield a single
    {'method':..., 'params':{...}} mapping; the stub records them unresolved.
    The generator body runs HERE, which is where a raw-string button raises
    `AttributeError: 'str' object has no attribute 'to_json'`. That error is
    returned rather than propagated, so the caller can report it as the bug it
    is instead of an unrelated crash.
    """
    if isinstance(command, dict):
        return command, None
    if hasattr(command, "__next__"):
        try:
            produced = next(command, None)
        except Exception as error:  # noqa: BLE001 - this IS the regression signal
            return {}, error
        return (produced if isinstance(produced, dict) else {}), None
    return {}, None


def _mouse_events(tab):
    """Return (events, failures) for the mouse events the tab recorded."""
    events, failures = [], []
    for command in tab.commands:
        resolved, error = _resolve(command)
        if error is not None:
            failures.append(error)
            continue
        if resolved.get("method") == "Input.dispatchMouseEvent":
            params = resolved.get("params") or {}
            events.append((params.get("type"), params.get("button")))
    return events, failures


async def _run(step):
    """Run one step through the real do_act; return (result, mouse events).

    do_act refuses to act without an open session, so the stub tab is installed
    as _tab AND a sentinel _browser, which is all the session check inspects.
    Nothing is started: the actor only touches the real browser in _ensure_tab.
    """
    tab = RecordingTab()
    originals = actor._tab, actor._evaluate, actor._rect, actor._browser
    actor._tab = tab
    actor._browser = object()

    async def fake_evaluate(*args, **kwargs):
        return True

    async def fake_rect(selector, *args, **kwargs):
        return {"x": 10.0, "y": 20.0, "w": 100.0, "h": 40.0}

    actor._evaluate = fake_evaluate
    actor._rect = fake_rect
    try:
        result = await actor.do_act({"steps": [step]})
    finally:
        actor._tab, actor._evaluate, actor._rect, actor._browser = originals
    events, failures = _mouse_events(tab)
    return result, events, failures


def _check(step, result, events, failures):
    label = step["type"]
    # A raw-string button raises while CDP serializes the command, which is the
    # exact regression this test exists for.
    assert not failures, (
        f"{label}: CDP command failed to serialize: {type(failures[0]).__name__}: {failures[0]}"
    )
    outcome = (result.get("steps") or [{}])[0]
    assert outcome.get("ok"), f"{label}: step failed: {outcome.get('error')}"
    assert events, f"{label}: dispatched no mouse events"
    for kind, button in events:
        # button is the serialized value: a plain string by this point, produced
        # only when the step handed CDP a proper MouseButton enum member.
        assert button in ("none", "left", "right", "middle"), (
            f"{label}: {kind} dispatched an unexpected button: {button!r}"
        )
    return f"{label}: {len(events)} event(s), buttons {sorted({b for _, b in events})}"


async def main():
    steps = [
        {"type": "hover", "selector": "#target"},
        {"type": "click", "selector": "#target"},
        {"type": "mousedown", "selector": "#target"},
        {"type": "mouseup", "selector": "#target"},
        {"type": "drag", "selector": "#target", "dx": 50, "dy": 25, "steps": 3},
    ]
    failures = []
    for step in steps:
        try:
            result, events, serialization = await _run(step)
            print(f"PASS: {_check(step, result, events, serialization)}")
        except Exception as error:  # noqa: BLE001 - report every failure, not just the first
            failures.append(f"{step['type']}: {type(error).__name__}: {error}")
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
