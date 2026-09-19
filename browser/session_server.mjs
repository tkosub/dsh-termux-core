// browser-session — stateful MCP server exposing ONE browser session.
// Tools: open / act / close. The python actor owns the Chromium lifecycle;
// this node process is a thin JSONL proxy plus the idle-retire timer.
//
// Resource model: exactly one session per server process. Chromium exists
// only between open and close (or idle retirement). A failed actor is
// reaped/replaced; errors never wedge later calls.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2024-11-05";
const PY = process.env.PYTHON3 || "python3";
const SERVE = process.env.BROWSER_SESSION_SERVE ||
  join(fileURLToPath(new URL(".", import.meta.url)), "session_serve.py");
const IDLE_MS_DEFAULT = 10 * 60 * 1000;
const TIMEOUT_DEFAULT = 90_000;

// ---------------------------------------------------------------------------
// actor management
// ---------------------------------------------------------------------------

let actor = null;         // {child, pending: Map<id,{resolve,reject,timer}>, nextId}
let session = {
  id: null,               // session id, stable while the actor is healthy
  browser: false,         // true while a page may be open inside the actor
  idleTimer: null,
  idleMs: IDLE_MS_DEFAULT,
  lastActivity: 0,
  closed: false,
};

function newSessionId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function log(...parts) {
  try {
    process.stderr.write(`[browser-session] ${parts.join(" ")}\n`);
  } catch {}
}

function reapActor() {
  if (!actor) return;
  const a = actor;
  actor = null;
  for (const { reject } of a.pending.values()) reject(new Error("actor restarted"));
  a.pending.clear();
  try { a.child.kill("SIGKILL"); } catch {}
}

function ensureActor() {
  if (actor) return actor;
  const a = { child: null, pending: new Map(), nextId: 1 };
  const child = spawn(PY, [SERVE], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],  // actor stderr piped; server forwards to its own stderr
  });
  child.stderr.on("data", (d) => { process.stderr.write(String(d)); });
  a.child = child;
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const id = msg && msg.id;
      if (id && a.pending.has(id)) {
        const p = a.pending.get(id);
        a.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  });
  child.on("error", (e) => {
    log("actor spawn error:", e.message);
    for (const { reject } of a.pending.values()) reject(new Error(`actor spawn error: ${e.message}`));
    a.pending.clear();
  });
  child.on("exit", (code, sig) => {
    if (actor === a) actor = null;
    for (const { reject } of a.pending.values()) reject(new Error(`actor exited (code=${code} sig=${sig})`));
    a.pending.clear();
  });
  actor = a;
  return a;
}

function actorCall(cmdObj, timeoutMs = TIMEOUT_DEFAULT) {
  const a = ensureActor();
  if (a.child.exitCode !== null || a.child.signalCode !== null) {
    // dead child: replace and fail the call so the model sees the crash
    reapActor();
    return Promise.reject(new Error("browser actor was not running; re-open the session"));
  }
  const id = a.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      a.pending.delete(id);
      reject(new Error(`actor call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    a.pending.set(id, { resolve, reject, timer });
    let line;
    try {
      line = JSON.stringify({ id, ...cmdObj });
    } catch (e) {
      clearTimeout(timer);
      a.pending.delete(id);
      reject(new Error(`cannot serialize request: ${e.message}`));
      return;
    }
    a.child.stdin.write(line + "\n", (err) => {
      if (err) {
        clearTimeout(timer);
        a.pending.delete(id);
        reject(new Error(`actor stdin error: ${err.message}`));
      }
    });
  });
}

function touchIdle() {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.lastActivity = Date.now();
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    log("idle timeout — closing session");
    session.closed = true;
    actorCall({ cmd: "close" }, 15_000)
      .finally(() => reapActor())
      .catch(() => {});
  }, session.idleMs);
  if (session.idleTimer.unref) session.idleTimer.unref();
}

function clearIdle() {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = null;
}

async function teardown() {
  clearIdle();
  if (actor) {
    try { await actorCall({ cmd: "shutdown" }, 10_000); } catch {}
  }
  reapActor();
}

// ---------------------------------------------------------------------------
// tool implementations (single-flight per tool; calls are serialized)
// ---------------------------------------------------------------------------

function markFailed() {
  // any error response from the actor means its session is unusable:
  // tear down so the next call starts clean.
  clearIdle();
  session.closed = true;
  if (actor) reapActor();
}

async function doOpen(args) {
  if (actor) {
    await actorCall({ cmd: "close" }, 15_000).catch(() => {});
    reapActor();
  }
  session.id = newSessionId();
  session.browser = false;
  session.closed = false;
  session.idleMs = Number(args.idle_ms) > 0 ? Number(args.idle_ms) : IDLE_MS_DEFAULT;
  const res = await actorCall({ cmd: "open", ...args });
  if (res && res.ok) {
    session.browser = true;
    touchIdle();
  } else {
    markFailed();
  }
  return { session_id: session.id, ...res };
}

async function doAct(args) {
  if (session.closed && !args.url) {
    return { ok: false, error: "session was closed; call open first (or pass url to act to start a new session)" };
  }
  if (!session.id) session.id = newSessionId();
  session.closed = false;
  const res = await actorCall({ cmd: "act", ...args });
  if (res && res.ok) {
    session.browser = true;
    touchIdle();
  } else {
    // step-level failures are reported inside res.steps; only hard actor
    // failures (res.ok false without steps) tear the session down.
    if (!res || !res.steps) markFailed();
    else touchIdle();
  }
  return { session_id: session.id, ...res };
}

async function doClose(args) {
  if (actor) {
    await actorCall({ cmd: "close" }, 15_000).catch(() => {});
    reapActor();
  }
  clearIdle();
  session.closed = true;
  session.browser = false;
  session.id = null;
  return { ok: true, closed: true };
}

// browse — the reconciled one-shot render tool, in the SAME server as the
// stateful session tools (migration plan step 1). Reuses a live session when
// one exists (navigating its tab, preserving the session); otherwise boots a
// fresh Chromium, renders, and CLOSES immediately so it never leaks a browser
// behind (close-hygiene; idle retire remains only a backstop).
async function doBrowse(args) {
  if (session.browser && actor) {
    // live session: reuse its tab by navigating in place
    const res = await actorCall({ cmd: "open", ...args });
    if (res && res.ok) touchIdle();
    else markFailed();
    return { session_id: session.id, reused: true, ...res };
  }
  // no live session: one-shot boot → render → close
  const opened = await doOpen(args);
  if (opened && opened.ok) {
    await doClose({});
    return { reused: false, ...opened };
  }
  return { reused: false, ...opened };
}

// ---------------------------------------------------------------------------
// MCP plumbing (same shape as mcp-web-tools/server.mjs)
// ---------------------------------------------------------------------------

function send(msg) { try { process.stdout.write(JSON.stringify(msg) + "\n"); } catch {} }
function result(id, r) { send({ jsonrpc: "2.0", id, result: r }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

const TOOLS = [
  {
    name: "browse",
    description:
      "Open a URL in a real headless Chromium (stealth flags, warm profile) and return the JS-RENDERED page title and visible text, optionally saving a screenshot. " +
      "Use for pages that need JavaScript or that block plain fetchers (Cloudflare etc.). Slower (~5-25s) than web_extract/fetch_raw — prefer those for static pages. " +
      "If a stateful session is already open it navigates that session's tab; otherwise it boots a fresh Chromium, renders, and closes immediately.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL" },
        wait_ms: { type: "number", description: "Extra render wait after load (default 3500)" },
        max_chars: { type: "number", description: "Max returned text chars (default 20000)" },
        screenshot_path: { type: "string", description: "Optional absolute .png path to save a viewport screenshot" },
      },
      required: ["url"],
    },
  },
  {
    name: "open",
    description:
      "Open a URL in the shared browser session (proot Chromium, stealth flags, warm profile). " +
      "The first open (or an act with a url) launches the browser; later open/act calls continue the SAME session. " +
      "Returns title + visible text (JS-rendered). The session auto-closes after an idle period (default 10 min) — " +
      "every open/act call resets the idle timer.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to open" },
        wait_ms: { type: "number", description: "Extra render wait after load (default 3500)" },
        max_chars: { type: "number", description: "Max returned text chars (default 20000)" },
        screenshot_path: { type: "string", description: "Optional .png path; result reports where it was saved" },
        idle_ms: { type: "number", description: "Idle auto-close for this session in ms (default 600000; 0 = never)" },
      },
      required: [],
    },
  },
  {
    name: "act",
    description:
      "Run interaction/read steps against the current session page (implicit open if a url is given and no session exists). " +
      "Steps run sequentially; the first failing step aborts the chain and reports per-step results. " +
      "Pointer input is TRUSTED CDP Input.*; set synthetic:true on a step to use DOM dispatchEvent instead " +
      "(for apps whose handlers only fire on JS-triggered events). eval requires an exact-match allowed_evals " +
      "entry or allow_any_eval:true (default deny).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Optional URL for implicit first open" },
        steps: {
          type: "array",
          description: "Steps to execute in order; abort on first failure.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["click", "mousedown", "mouseup", "hover", "drag", "scroll",
                       "type", "press", "eval", "read", "screenshot", "wait", "navigate"],
                description: "Step kind",
              },
              selector: { type: "string", description: "CSS selector (or 'xpath=<expr>')" },
              text: { type: "string", description: "type: text to enter" },
              key: { type: "string", description: "press: key name (Enter, Tab, Escape, ArrowUp, ...)" },
              expr: { type: "string", description: "eval: JS expression in the page — DENIED unless allowlisted" },
              dx: { type: "number", description: "drag/scroll: delta x" },
              dy: { type: "number", description: "drag/scroll: delta y" },
              steps: { type: "number", description: "drag: interpolation steps (default 10)" },
              mode: { type: "string", enum: ["text", "value", "html", "attr"], description: "read mode (default text)" },
              attr: { type: "string", description: "read mode=attr: attribute name" },
              max_chars: { type: "number", description: "read: truncation cap" },
              path: { type: "string", description: "screenshot: output .png path" },
              ms: { type: "number", description: "wait: milliseconds" },
              synthetic: { type: "boolean", description: "click/type: use DOM dispatchEvent instead of trusted CDP" },
            },
            required: ["type"],
          },
        },
        allowed_evals: { type: "array", items: { type: "string" }, description: "Exact-match eval allowlist for this call" },
        allow_any_eval: { type: "boolean", description: "Allow any eval expression this call (default false)" },
        max_chars: { type: "number", description: "Default truncation cap for read steps" },
      },
      required: ["steps"],
    },
  },
  {
    name: "close",
    description:
      "Explicitly close the browser session: stops Chromium and reaps its process tree. Idempotent; " +
      "safe to call at any time. Strongly suggested once a particular browse is done — releases the " +
      "Chromium process immediately instead of waiting for the idle timer, keeping memory/process " +
      "pressure down. Sessions also auto-close after the idle period or after a crash.",
    inputSchema: { type: "object", properties: {} },
  },
];

// single-flight chain: serialize all tool calls (actor handles one at a time)
let chain = Promise.resolve();
function serialized(fn) {
  const run = () => fn();
  chain = chain.then(run, run);
  return chain;
}

async function callTool(name, args) {
  switch (name) {
    case "browse": return serialized(() => doBrowse(args ?? {}));
    case "open": return serialized(() => doOpen(args ?? {}));
    case "act": return serialized(() => doAct(args ?? {}));
    case "close": return serialized(() => doClose(args ?? {}));
    default: throw new Error(`unknown tool: ${name}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  const { id, method, params } = msg;
  if (method === undefined) return;
  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "browser", version: "2.0.0" },
      });
      break;
    case "ping": result(id, {}); break;
    case "tools/list": result(id, { tools: TOOLS }); break;
    case "tools/call":
      callTool(String(params?.name ?? ""), params?.arguments ?? {})
        .then((text) => result(id, { content: [{ type: "text", text: JSON.stringify(text) }] }))
        .catch((e) => result(id, { content: [{ type: "text", text: `error: ${e.message}` }], isError: true }));
      break;
    case "notifications/initialized":
    case "notifications/cancelled":
      break;
    default:
      if (id !== undefined) error(id, -32601, `method not found: ${method}`);
  }
});

rl.on("close", () => {
  // stdin EOF (the MCP client / dsh host died): tear down NOW, do not linger.
  log("stdin closed — shutting down");
  teardown()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});

process.on("exit", () => { /* teardown is async; use explicit paths above */ });
process.on("SIGINT", () => { teardown().then(() => process.exit(0)); });
process.on("SIGTERM", () => { teardown().then(() => process.exit(0)); });
