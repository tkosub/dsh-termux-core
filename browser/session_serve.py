#!/usr/bin/env python3
"""session_serve.py — stateful browser actor for the dsh MCP session server.

Long-lived python process (spawned once per browser-session MCP server). Owns
ONE proot-Chromium tab at a time over nodriver. Speaks newline-JSON on stdin/
stdout; exits 0 when it sees {"cmd":"shutdown"}. Ignores unrecognized/empty
lines. stderr carries diagnostics only (never JSON).

Protocol requests (one JSON per stdin line):
  {"cmd":"open","url":"...","wait_ms":3500,"max_chars":20000,"screenshot":null}
  {"cmd":"act","steps":[...]}
  {"cmd":"close"}
  {"cmd":"status"}
  {"cmd":"shutdown"}
Each response is one JSON line on stdout:
  {"ok":true,...} | {"ok":false,"error":"..."}

Resource discipline:
  - Chromium exists ONLY between a successful open and close/shutdown. No
    guarantee any lifecycle event leaves a browser behind.
  - A failed open/act marks the actor for close-before-next-open; close is
    idempotent; shutdown always tears down.
  - Callers should close as soon as a particular browse is done: the idle
    auto-retire is a backstop, not the intended teardown path — closing
    releases Chromium immediately (memory/process pressure on Android).

Step contract (act) — see step contract in _meta doc:
  click/hover/mousedown/mouseup/drag/scroll/type/press/key/read/eval/wait/
  navigate/screenshot. Synthetic flag per step switches click/type to DOM
  dispatchEvent. eval is gated: allowed = allowed_evals contains EXACT match
  of the step's expr (allowlist), OR allow_any_eval=true.
"""
import asyncio
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# Helpers MUST ship co-located with this actor (repo browser/ dir); never
# resolve them across host-specific absolute paths.
sys.path.insert(0, HERE)

import nodriver as uc
from stealth_browser import stealth_start
from proot_reap import reap as _reap

# Session Chromium gets its own user-data dir, distinct from the old one-shot
# browse profile. Env-overridable so deployments can relocate without code
# edits; the reap substring must match the dir actually used.
SESSION_USER_DATA = os.environ.get(
    "BROWSER_SESSION_USER_DATA",
    os.path.join(os.path.expanduser("~"), ".cache", "browser-session", "user-data"),
)
SESSION_PROFILE_SUBSTR = os.environ.get(
    "BROWSER_SESSION_PROFILE_SUBSTR",
    "browser-session/user-data",
)

# Runtime gate config (mutable per act request):
ALLOW_ANY_EVAL = False
ALLOWED_EVALS = []  # exact-match allowlist

MAX_CHARS_DEFAULT = 20000
MAX_STEPS = 100
BROWSER_START_TIMEOUT = 60.0

_browser = None
_tab = None
_need_close = False
_retire_deadline = None   # monotonic; None = no session/no retire pending
_retire_ms_actor = 90_000 # hard actor-side cap for any single wait
_ppid = os.getppid()      # parent watchdog: if our parent changes, exit


def _scrub_leftovers():
    """Reap any stale Chromium using OUR session profile. Only safe because the
    session profile is distinct from the browse server's shared warm profile."""
    try:
        _reap(SESSION_PROFILE_SUBSTR)
    except Exception:
        pass


def _clear_singleton_locks():
    """Remove stale Chromium singleton locks in OUR session profile. A killed
    browser leaves SingletonLock/Socket/Cookie behind; a fresh Chromium then
    refuses to start (believes another instance owns the profile) and exits
    immediately, surfacing as FileNotFoundError on the launcher."""
    import glob
    try:
        for lock in glob.glob(os.path.join(SESSION_USER_DATA, "Singleton*")):
            try:
                os.remove(lock)
            except Exception:
                pass
    except Exception:
        pass


class StepError(Exception):
    pass



def send(obj):
    line = json.dumps(obj, ensure_ascii=False, default=str)
    try:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def _norm_sel(sel):
    if not isinstance(sel, str) or not sel.strip():
        raise StepError("selector required (CSS or 'xpath=<expr>')")
    return sel


def _find_expr(sel):
    s = sel.strip()
    if s.startswith("xpath="):
        return f"document.evaluate({json.dumps(s[6:])}, document, null, 9, null).singleNodeValue"
    return f"document.querySelector({json.dumps(s)})"


async def _evaluate(tab, expr):
    return await asyncio.wait_for(tab.evaluate(expr), timeout=30.0)


async def _ensure_browser():
    global _browser, _tab, _need_close
    if _browser is None:
        _scrub_leftovers()
        _clear_singleton_locks()
        async def _launch():
            return await stealth_start(headless=True, user_data_dir=SESSION_USER_DATA)
        _browser = await asyncio.wait_for(_launch(), timeout=BROWSER_START_TIMEOUT)
        _tab = None
    return _browser


async def _ensure_tab(url=None):
    global _tab
    await _ensure_browser()
    if _tab is None:
        if url:
            _tab = await asyncio.wait_for(_browser.get(url), timeout=60.0)
        else:
            tabs = await _browser.tabs
            _tab = tabs[0] if tabs else None
    return _tab


async def do_open(cmd):
    global _need_close, _tab, _retire_deadline
    url = cmd.get("url")
    wait_ms = int(cmd.get("wait_ms") or 3500)
    max_chars = int(cmd.get("max_chars") or MAX_CHARS_DEFAULT)
    screenshot = cmd.get("screenshot")
    if not url:
        return {"ok": False, "error": "open requires a url"}
    _retire_deadline = time.monotonic() + _retire_ms_actor
    try:
        if _need_close:
            await do_close({})
        await _ensure_browser()
        _tab = await asyncio.wait_for(_browser.get(url), timeout=60.0)
        if wait_ms > 0:
            await asyncio.sleep(min(wait_ms / 1000.0, _retire_ms_actor / 1000.0))
        title = await _evaluate(_tab, "document.title")
        text = await _evaluate(_tab, "(document.body ? document.body.innerText : '') || ''")
        if isinstance(text, str) and len(text) > max_chars:
            text = text[:max_chars] + f"\n\n[truncated at {max_chars} chars]"
        out = {"ok": True, "url": url, "title": title if isinstance(title, str) else "",
               "text": text if isinstance(text, str) else ""}
        if screenshot:
            try:
                saved = await _tab.save_screenshot(screenshot)
                out["screenshot_path"] = saved if isinstance(saved, str) else screenshot
            except Exception as e:
                out["screenshot_error"] = str(e)
        return out
    except Exception as e:
        _need_close = True
        import traceback as _tb
        _tb.print_exc(file=sys.stderr)
        return {"ok": False, "url": url, "error": str(e)}


def _parse_preview(v):
    """nodriver returns plain objects as RemoteObject previews:
    [['x', {'type': 'number', 'value': 1614.0}], ...]. Convert to a dict,
    or return scalars/strings unchanged."""
    if isinstance(v, list) and v and all(
            isinstance(i, list) and len(i) == 2 and isinstance(i[0], str)
            for i in v):
        d = {}
        for k, info in v:
            if isinstance(info, dict) and "value" in info:
                d[k] = info["value"]
            elif isinstance(info, dict) and "description" in info:
                d[k] = info["description"]
        return d
    return v


async def _rect(sel):
    expr = (f"(function(){{var e={_find_expr(sel)};"
            f"if(!e)return null;var r=e.getBoundingClientRect();"
            f"return {{x:r.x,y:r.y,w:r.width,h:r.height}};}})()")
    r = _parse_preview(await _evaluate(_tab, expr))
    if not r:
        raise StepError(f"selector not found: {sel}")
    if not all(k in r for k in ("x", "y", "w", "h")):
        raise StepError(f"bad rect payload for {sel}: {r}")
    if r["w"] <= 0 or r["h"] <= 0:
        raise StepError(f"element has zero size (hidden?): {sel}")
    return r


async def _scroll_into_view(sel):
    await _evaluate(_tab, f"(function(){{var e={_find_expr(sel)};if(e)e.scrollIntoView({{block:'center'}});return !!e;}})()")


async def _xy(sel, dx=0, dy=0):
    r = await _rect(sel)
    return (r["x"] + r["w"] / 2 + (dx or 0), r["y"] + r["h"] / 2 + (dy or 0))


def _modmask(mods):
    mask = 0
    for m in (mods or []):
        mask |= {"alt": 1, "ctrl": 2, "meta": 4, "shift": 8}.get(m, 0)
    return mask


def _mouse_button(name):
    b = {"left": uc.cdp.input_.MouseButton.LEFT,
         "right": uc.cdp.input_.MouseButton.RIGHT,
         "middle": uc.cdp.input_.MouseButton.MIDDLE}.get((name or "left").lower())
    if b is None:
        raise StepError(f"unsupported button: {name}")
    return b


async def _cdp_mouse(type_, x, y, button="left", mods=None, count=1):
    await _tab.send(uc.cdp.input_.dispatch_mouse_event(
        type_=type_, x=x, y=y, button=_mouse_button(button), buttons=None,
        modifiers=_modmask(mods), click_count=count, pointer_type="mouse"))


async def _mouse_distribute(s, x, y, button="left", mods=None, count=1, steps=1):
    await _tab.send(uc.cdp.input_.dispatch_mouse_event(
        type_="mouseMoved", x=x, y=y, button=button, buttons=0,
        modifiers=_modmask(mods), click_count=count, pointer_type="mouse"))
    for i in range(1, steps + 1):
        fx = s[0] + (x - s[0]) * i / steps
        fy = s[1] + (y - s[1]) * i / steps
        await _tab.send(uc.cdp.input_.dispatch_mouse_event(
            type_="mouseMoved", x=fx, y=fy, button=button, buttons=0,
            modifiers=_modmask(mods), click_count=count, pointer_type="mouse"))


async def _click_events(x, y, button="left", mods=None, click_count=1):
    btn = _mouse_button(button)
    await _tab.send(uc.cdp.input_.dispatch_mouse_event(
        type_="mousePressed", x=x, y=y, button=btn,
        buttons={ "left": 1, "right": 2, "middle": 4 }.get(button.lower(), 1),
        modifiers=_modmask(mods), click_count=click_count, pointer_type="mouse"))
    await _tab.send(uc.cdp.input_.dispatch_mouse_event(
        type_="mouseReleased", x=x, y=y, button=btn, buttons=0,
        modifiers=_modmask(mods), click_count=click_count, pointer_type="mouse"))


async def _step_click(st):
    sel = _norm_sel(st.get("selector"))
    if st.get("synthetic"):
        expr = (f"(function(){{var e={_find_expr(sel)};if(!e)return false;"
                f"e.dispatchEvent(new MouseEvent('click',{{bubbles:true,cancelable:true}}));return true;}})()")
        done = await _evaluate(_tab, expr)
        if not done:
            raise StepError(f"selector not found: {sel}")
        return {"clicked": sel}
    await _scroll_into_view(sel)
    x, y = await _xy(sel)
    await _click_events(x, y)
    return {"clicked": sel, "x": round(x, 1), "y": round(y, 1)}


async def _step_press_or_mouse(st, kind):
    # mousedown/mouseup/click/hover — CDP trusted input by default
    sel = _norm_sel(st.get("selector"))
    await _scroll_into_view(sel)
    x, y = await _xy(sel)
    if kind in ("mousedown", "mouseup", "click"):
        await _click_events(x, y)
        return {kind: sel, "x": round(x, 1), "y": round(y, 1)}
    # hover = move only
    await _tab.send(uc.cdp.input_.dispatch_mouse_event(
        type_="mouseMoved", x=x, y=y, button="none", buttons=0,
        modifiers=0, click_count=0, pointer_type="mouse"))
    return {"hovered": sel, "x": round(x, 1), "y": round(y, 1)}


async def _step_drag(st):
    sel = _norm_sel(st.get("selector"))
    dx = float(st.get("dx") or 0)
    dy = float(st.get("dy") or 0)
    steps = int(st.get("steps") or 10)
    await _scroll_into_view(sel)
    x, y = await _xy(sel)
    await _mouse_distribute((x, y), x, y)
    await _click_events(x, y)
    sx, sy = x, y
    for i in range(1, steps + 1):
        fx, fy = x + dx * i / steps, y + dy * i / steps
        await _tab.send(uc.cdp.input_.dispatch_mouse_event(
            type_="mouseMoved", x=fx, y=fy, button="left",
            buttons=1, modifiers=0, click_count=1, pointer_type="mouse"))
    await _tab.send(uc.cdp.input_.dispatch_mouse_event(
        type_="mouseReleased", x=x + dx, y=y + dy, button=uc.cdp.input_.MouseButton.LEFT,
        buttons=0, modifiers=0, click_count=1, pointer_type="mouse"))
    return {"dragged": sel, "dx": dx, "dy": dy, "from": (round(sx, 1), round(sy, 1))}


async def _step_scroll(st):
    sel = st.get("selector")
    dx = float(st.get("dx") or 0)
    dy = float(st.get("dy") or 0)
    if sel:
        expr = (f"(function(){{var e={_find_expr(sel)};if(!e)return false;"
                f"e.scrollBy({{left:{dx},top:{dy},behavior:'auto'}});return true;}})()")
        done = await _evaluate(_tab, expr)
        if not done:
            raise StepError(f"selector not found: {sel}")
        return {"scrolled": sel, "dx": dx, "dy": dy}
    # global: mouse wheel
    await _tab.send(uc.cdp.input_.dispatch_mouse_event(
        type_="mouseWheel", x=0, y=0, delta_x=dx, delta_y=dy, modifiers=0))
    return {"scrolled": "viewport", "dx": dx, "dy": dy}


async def _step_type(st):
    sel = _norm_sel(st.get("selector"))
    text = str(st.get("text") or "")
    if st.get("synthetic"):
        expr = (f"(function(){{var e={_find_expr(sel)};if(!e)return false;"
                f"var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;"
                f"set.call(e,{json.dumps(text)});e.dispatchEvent(new Event('input',{{bubbles:true}}));return true;}})()")
        done = await _evaluate(_tab, expr)
        if not done:
            raise StepError(f"selector not found: {sel}")
        await _evaluate(_tab, f"(function(){{var e={_find_expr(sel)};if(e)e.dispatchEvent(new Event('change',{{bubbles:true}}));return true;}})()")
        return {"typed": sel, "chars": len(text), "synthetic": True}
    await _scroll_into_view(sel)
    x, y = await _xy(sel)
    await _click_events(x, y)
    for ch in text:
        if ch == "\n":
            await _tab.send(uc.cdp.input_.dispatch_key_event(type_="keyDown", key="Enter", code="Enter", windows_virtual_key_code=13, native_virtual_key_code=13, text="\r", unmodified_text="\r"))
            await _tab.send(uc.cdp.input_.dispatch_key_event(type_="keyUp", key="Enter", code="Enter", windows_virtual_key_code=13, native_virtual_key_code=13))
            continue
        await _tab.send(uc.cdp.input_.dispatch_key_event(type_="keyDown", key=ch, code="", windows_virtual_key_code=0, native_virtual_key_code=0, text=ch, unmodified_text=ch))
        await _tab.send(uc.cdp.input_.dispatch_key_event(type_="keyUp", key=ch, code="", windows_virtual_key_code=0, native_virtual_key_code=0))
    return {"typed": sel, "chars": len(text), "synthetic": False}


async def _step_press_key(st):
    key = str(st.get("key") or "")
    if not key:
        raise StepError("press requires key")
    code = {"Enter": "Enter", "Tab": "Tab", "Escape": "Escape", "Backspace": "Backspace",
            "ArrowDown": "ArrowDown", "ArrowUp": "ArrowUp", "ArrowLeft": "ArrowLeft",
            "ArrowRight": "ArrowRight"}.get(key, "")
    vk = {"Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8, "ArrowDown": 40,
          "ArrowUp": 38, "ArrowLeft": 37, "ArrowRight": 39}.get(key, 0)
    await _tab.send(uc.cdp.input_.dispatch_key_event(type_="keyDown", key=key, code=code,
                                                     windows_virtual_key_code=vk, native_virtual_key_code=vk))
    await _tab.send(uc.cdp.input_.dispatch_key_event(type_="keyUp", key=key, code=code,
                                                     windows_virtual_key_code=vk, native_virtual_key_code=vk))
    return {"pressed": key}


async def _step_eval(st, req):
    global ALLOW_ANY_EVAL, ALLOWED_EVALS
    expr = str(st.get("expr") or "")
    if not expr.strip():
        raise StepError("eval requires expr")
    if not (req.get("allow_any_eval") or (expr in ALLOWED_EVALS)):
        raise StepError("eval denied: expr not allowlisted and allow_any_eval not set")
    val = await _evaluate(_tab, expr)
    return {"result": val}


async def _step_read(st, req):
    sel = _norm_sel(st.get("selector"))
    max_chars = int(st.get("max_chars") or req.get("max_chars") or 20000)
    mode = st.get("mode") or "text"
    if mode == "text":
        expr = (f"(function(){{var e={_find_expr(sel)};if(!e)return null;"
                f"return (e.innerText||e.value||'').slice(0,{max_chars});}})()")
    elif mode == "value":
        expr = f"(function(){{var e={_find_expr(sel)};if(!e)return null;return (e.value||'').slice(0,{max_chars});}})()"
    elif mode == "html":
        expr = f"(function(){{var e={_find_expr(sel)};if(!e)return null;return (e.outerHTML||'').slice(0,{max_chars});}})()"
    elif mode == "attr":
        attr = st.get("attr")
        if not attr:
            raise StepError("attr mode requires attr")
        expr = f"(function(){{var e={_find_expr(sel)};if(!e)return null;return e.getAttribute({json.dumps(attr)});}})()"
    else:
        raise StepError(f"unknown read mode: {mode}")
    val = await _evaluate(_tab, expr)
    return {"value": val}


async def _step_screenshot(st, req):
    path = st.get("path") or req.get("screenshot_path") or ""
    if not path:
        raise StepError("screenshot step requires path")
    saved = await _tab.save_screenshot(path)
    return {"screenshot_path": saved if isinstance(saved, str) else path}


async def apply_wait(ms):
    if ms > 0:
        await asyncio.sleep(ms / 1000.0)
        if _retire_deadline and time.monotonic() >= _retire_deadline:
            raise StepError("session auto-retired (idle deadline) while waiting")


async def _steps_impl(steps, req):
    global ALLOW_ANY_EVAL, ALLOWED_EVALS, _tab, _need_close
    if not isinstance(steps, list) or not steps:
        raise StepError("steps must be a non-empty array")
    if len(steps) > MAX_STEPS:
        raise StepError(f"too many steps (max {MAX_STEPS})")
    if req.get("allow_any_eval"):
        ALLOW_ANY_EVAL = True
    if isinstance(req.get("allowed_evals"), list):
        ALLOWED_EVALS = [str(x) for x in req["allowed_evals"]]
    results = []
    for st in steps:
        if not isinstance(st, dict):
            raise StepError(f"step must be an object, got {type(st).__name__}")
        typ = st.get("type")
        try:
            if typ == "click":
                r = await _step_click(st)
            elif typ in ("mousedown", "mouseup", "hover"):
                r = await _step_press_or_mouse(st, typ)
            elif typ == "drag":
                r = await _step_drag(st)
            elif typ == "scroll":
                r = await _step_scroll(st)
            elif typ == "type":
                r = await _step_type(st)
            elif typ == "press":
                r = await _step_press_key(st)
            elif typ == "key":
                r = await _step_press_key(st)
            elif typ == "eval":
                r = await _step_eval(st, req)
            elif typ == "read":
                r = await _step_read(st, req)
            elif typ == "screenshot":
                r = await _step_screenshot(st, req)
            elif typ == "wait":
                ms = int(st.get("ms") or 0)
                if ms > 0:
                    await apply_wait(ms)
                r = {"waited": ms}
            elif typ == "navigate":
                u = st.get("url")
                if not u:
                    raise StepError("navigate requires url")
                await asyncio.wait_for(_tab.get(u), timeout=60.0)
                r = {"navigated": u}
            else:
                raise StepError(f"unknown step type: {typ}")
            results.append({"index": len(results), "ok": True, **r})
        except StepError as e:
            results.append({"index": len(results), "ok": False, "error": str(e)})
            break
        except Exception as e:
            results.append({"index": len(results), "ok": False, "error": f"{type(e).__name__}: {e}"})
            _need_close = True
            break
    return {"steps": results, "all_ok": all(r.get("ok") for r in results)}


async def do_act(cmd):
    global _need_close
    url = cmd.get("url")
    try:
        if _browser is None or _tab is None:
            if url:
                await _ensure_tab(url)
            else:
                return {"ok": False, "error": "no open session; call open first or pass url to act"}
        if _need_close:
            await do_close({})
            try:
                if url:
                    await _ensure_tab(url)
                else:
                    await _ensure_tab()
            except Exception:
                return {"ok": False, "error": "session was closed (crash); call open first"}
        impl = await _steps_impl(cmd.get("steps") or [], cmd)
        return {"ok": bool(impl.get("all_ok")), **impl}
    except Exception as e:
        _need_close = True
        return {"ok": False, "error": str(e)}


async def do_close(cmd):
    global _browser, _tab, _need_close, _retire_deadline
    try:
        if _browser is not None:
            try:
                await _browser.stop()
            except Exception:
                pass
    finally:
        _browser = None
        _tab = None
        _need_close = False
        _retire_deadline = None
        _scrub_leftovers()
    return {"ok": True, "closed": True}


async def do_status(cmd):
    return {"ok": True, "has_browser": _browser is not None, "has_tab": _tab is not None,
            "need_close": _need_close}


async def main_loop():
    loop = asyncio.get_running_loop()
    r_reader, w_writer = None, None
    # minimal stdin reader: a synchronous blocking read moved to a thread is
    # unreliable with node's pipe; use a dedicated reader coroutine on a socket
    # pair instead — but the MCP client pipes are plain pipes; block on them
    # with os.read in a thread and process lines as they arrive.
    import os as _os
    fd = sys.stdin.fileno()
    buf = b""
    while True:
        chunk = await asyncio.to_thread(_os.read, fd, 4096)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception:
                continue
            await _handle(req)
    try:
        await do_close({})
    except Exception:
        pass


async def _handle(req):
    if os.getppid() != _ppid:
        try:
            await do_close({})
        except Exception:
            pass
        return
    rid = req.get("id")
    cmd = req.get("cmd")
    if cmd == "shutdown":
        try:
            await do_close({})
        except Exception:
            pass
        send({"ok": True, "shutdown": True, "id": rid})
        return
    try:
        if cmd == "open":
            r = await do_open(req)
        elif cmd == "act":
            r = await do_act(req)
        elif cmd == "close":
            r = await do_close(req)
        elif cmd == "status":
            r = await do_status(req)
        else:
            r = {"ok": False, "error": f"unknown cmd: {cmd}"}
    except Exception as e:
        r = {"ok": False, "error": str(e)}
    r["id"] = rid
    send(r)


if __name__ == "__main__":
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        pass
