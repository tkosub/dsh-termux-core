// browser-session — MCP server exposing ONE declared browser session.
// Tools: status / open / act / close / browse.
//
// Resource model: Chromium costs ~800 MB on this phone, so a browser session is
// an EXPLICIT act with a declared owner, and there is exactly one at a time
// across every DSH session (this server is a runtime-global singleton, spawned
// once per `dsh web` process and shared by all sessions).
//
// Enforcement lives HERE, not in the Chromium launcher: this is the only path
// the MCP tools have to a browser, it knows the caller's declaration, and it can
// answer a second caller with a structured refusal instead of a crashed launch.
// The launcher stays a portable pass-through.
//
// Locking: an O_EXCL lock record naming the owner, plus a liveness proof — the
// record is only honoured while the recorded pid still exists AND its kernel
// start time matches, so a killed or crashed server releases the session
// automatically and a stale record can never lock the browser out. Nothing is
// inherited into proot/Chromium, so no orphan process can hold it. The record
// doubles as the "held by" report.
//
// There is no preemption path: only the owner may close its session, and closing
// is a CDP close, never a signal.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";

const VERSION = "2024-11-05";
const PY = process.env.PYTHON3 || "python3";
const SERVE = process.env.BROWSER_SESSION_SERVE ||
  join(fileURLToPath(new URL(".", import.meta.url)), "session_serve.py");
const IDLE_MS_DEFAULT = 10 * 60 * 1000;
const IDLE_MS_MIN = 30_000;
const IDLE_MS_MAX = 30 * 60 * 1000;   // no session may be held indefinitely
const TIMEOUT_DEFAULT = 90_000;
const OWNER_MAX = 80;

// Portable by construction: derived from the home directory, overridable, with
// no host-specific absolute path baked in.
const RUN_DIR = process.env.DSH_BROWSER_SESSION_RUN || join(homedir(), ".dsh", "run");
const LOCK_FILE = join(RUN_DIR, "browser-session.lock");

// ---------------------------------------------------------------------------
// actor management
// ---------------------------------------------------------------------------

let actor = null;         // {child, pending: Map<id,{resolve,reject,timer}>, nextId}
let session = {
  id: null,               // session id, stable while the actor is healthy
  owner: null,            // declared owner of the current session
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
      .finally(() => { reapActor(); releaseLock(); })
      .catch(() => { releaseLock(); });
  }, session.idleMs);
  if (session.idleTimer.unref) session.idleTimer.unref();
}

function clearIdle() {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = null;
}

function clampIdle(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return IDLE_MS_DEFAULT;
  return Math.min(Math.max(n, IDLE_MS_MIN), IDLE_MS_MAX);
}

async function teardown() {
  clearIdle();
  if (actor) {
    try { await actorCall({ cmd: "shutdown" }, 10_000); } catch {}
  }
  reapActor();
  releaseLock();
}

// ---------------------------------------------------------------------------
// ownership: declared owner + single-session lock with a liveness proof
// ---------------------------------------------------------------------------

// Kernel start time (field 22 of /proc/<pid>/stat, i.e. index 19 past ") ").
// Together with the pid this identifies the exact process, closing the pid-reuse
// window that a bare "is the pid alive" check leaves open.
function procStartTicks(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

function readRawLock() {
  try { return readFileSync(LOCK_FILE, "utf8"); } catch { return null; }
}

function parseLock(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

function lockRecord() { return parseLock(readRawLock()); }

function lockAlive(rec) {
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0) return false;
  if (typeof rec.starttime !== "string" && typeof rec.starttime !== "number") return false;
  return procStartTicks(rec.pid) === rec.starttime;
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function holderOf(rec) {
  return {
    owner: rec && rec.owner ? String(rec.owner) : "unknown",
    since: rec && rec.started ? rec.started : null,
    session_id: rec && rec.session_id ? rec.session_id : null,
    pid: rec && rec.pid ? rec.pid : null,
    server: rec && rec.pid === process.pid ? "this dsh runtime" : "another dsh runtime",
  };
}

function ownRecord(owner) {
  return {
    owner,
    pid: process.pid,
    started: new Date().toISOString(),
    starttime: procStartTicks(process.pid),
    session_id: session.id,
  };
}

function acquireLock(owner) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = readRawLock();
    const rec = parseLock(raw);
    if (lockAlive(rec)) {
      if (String(rec.owner) === owner && rec.pid === process.pid) return { ok: true };
      return { ok: false, held: holderOf(rec) };
    }
    if (raw !== null) {
      // The file exists but does not prove a LIVE holder: an empty or partial
      // write (flock(1) and friends create this path empty), a record from an
      // older build, or a holder process that is gone. Honouring such a record
      // would lock the browser out forever — the one failure this gate must
      // never produce. Only a verified live holder may ever refuse a caller.
      const hadPid = !!(rec && Number.isInteger(rec.pid));
      log(`clearing unusable lock record (${hadPid ? `holder pid ${rec.pid} is not alive` : "empty or unparseable"})`);
      try { rmSync(LOCK_FILE, { force: true }); } catch {}
      if (!hadPid) sleepSync(120);   // a concurrent acquire may be mid-write
    }
    try {
      mkdirSync(RUN_DIR, { recursive: true });
      writeFileSync(LOCK_FILE, JSON.stringify(ownRecord(owner)) + "\n", { flag: "wx", mode: 0o600 });
      session.owner = owner;
      return { ok: true };
    } catch (e) {
      if (e && e.code === "EEXIST") continue;   // raced another claimant: re-evaluate it
      return { ok: false, error: `cannot write ${LOCK_FILE}: ${e.message}` };
    }
  }
  const rec = lockRecord();
  return lockAlive(rec)
    ? { ok: false, held: holderOf(rec) }
    : { ok: false, error: `${LOCK_FILE} could not be acquired or verified` };
}

function releaseLock() {
  const rec = lockRecord();
  // Never release a session this process does not hold.
  if (!rec || rec.pid === process.pid) {
    try { rmSync(LOCK_FILE, { force: true }); } catch {}
  }
  session.owner = null;
}

function requireOwner(args) {
  const raw = args ? args.owner : undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      error:
        "owner is required and no browser was started. Declare who owns this session — " +
        "your DSH session id, or your role/name if you work in a team — e.g. owner=\"<your id>\". " +
        "Only the owner can act on or close the session.",
    };
  }
  return { owner: raw.trim().slice(0, OWNER_MAX) };
}

function heldBy(held, extra) {
  return {
    ok: false,
    refused: "held_by",
    held_by: held ? held.owner : "unknown",
    held_since: held ? held.since : null,
    held_session_id: held ? held.session_id : null,
    guidance:
      "Another agent owns the browser session. Ask it to close it (mcp__browser__close with its owner). " +
      "Do NOT kill any chromium/proot process to get the session; an abandoned session retires on its own " +
      "idle timer. Check who holds it with mcp__browser__status.",
    ...extra,
  };
}

function noOwner(error) {
  return { ok: false, refused: "no_owner", guidance: error };
}

// The owner declaration is server-side policy; the python actor does not take it.
function strip(args) {
  const { owner, ...rest } = args ?? {};
  return rest;
}

// ---------------------------------------------------------------------------
// tool implementations (single-flight per tool; calls are serialized)
// ---------------------------------------------------------------------------

function markFailed() {
  // any error response from the actor means its session is unusable:
  // tear down so the next call starts clean, and hand the browser back.
  clearIdle();
  session.closed = true;
  if (actor) reapActor();
  releaseLock();
}

async function doOpen(args) {
  const o = requireOwner(args);
  if (o.error) return noOwner(o.error);
  const got = acquireLock(o.owner);
  if (!got.ok) return got.error ? { ok: false, refused: "lock_error", error: got.error } : heldBy(got.held);
  const rest = strip(args);
  if (actor) {
    await actorCall({ cmd: "close" }, 15_000).catch(() => {});
    reapActor();
  }
  session.id = newSessionId();
  session.browser = false;
  session.closed = false;
  session.idleMs = clampIdle(rest.idle_ms);
  const res = await actorCall({ cmd: "open", ...rest });
  if (res && res.ok) {
    session.browser = true;
    // rewrite the record now that a session id exists
    releaseLock();
    if (!acquireLock(o.owner).ok) {
      return { ...res, session_id: session.id, owner: o.owner, warning: "session opened but the lock was lost" };
    }
    touchIdle();
  } else {
    markFailed();
  }
  return { session_id: session.id, owner: o.owner, ...res };
}

async function doAct(args) {
  const o = requireOwner(args);
  if (o.error) return noOwner(o.error);
  const got = acquireLock(o.owner);
  if (!got.ok) return got.error ? { ok: false, refused: "lock_error", error: got.error } : heldBy(got.held);
  const rest = strip(args);
  if (session.closed && !rest.url) {
    releaseLock();
    return { ok: false, error: "session was closed; call open first (or pass url to act to start a new session)" };
  }
  if (!session.id) session.id = newSessionId();
  session.closed = false;
  const res = await actorCall({ cmd: "act", ...rest });
  if (res && res.ok) {
    session.browser = true;
    touchIdle();
  } else {
    // step-level failures are reported inside res.steps; only hard actor
    // failures (res.ok false without steps) tear the session down.
    if (!res || !res.steps) markFailed();
    else touchIdle();
  }
  return { session_id: session.id, owner: o.owner, ...res };
}

async function doClose(args) {
  const o = requireOwner(args);
  if (o.error) return noOwner(o.error);
  const rec = lockRecord();
  if (lockAlive(rec) && String(rec.owner) !== o.owner) {
    return heldBy(holderOf(rec), {
      guidance: "Only the owner can close a session. Ask the holder to close it, or wait for its idle timer.",
    });
  }
  if (actor) {
    await actorCall({ cmd: "close" }, 15_000).catch(() => {});
    reapActor();
  }
  clearIdle();
  session.closed = true;
  session.browser = false;
  session.id = null;
  releaseLock();
  return { ok: true, closed: true, owner: o.owner };
}

// status — read-only, needs no owner: whoever is locked out must be able to see
// who holds the browser without spending a Chromium boot to find out.
async function doStatus() {
  const rec = lockRecord();
  const alive = lockAlive(rec);
  return {
    ok: true,
    session_open: !!(alive && session.browser && actor),
    held_by: alive ? holderOf(rec) : null,
    idle_ms_left: alive && session.idleTimer
      ? Math.max(0, session.idleMs - (Date.now() - session.lastActivity))
      : null,
    lock_file: LOCK_FILE,
  };
}

// browse — one-shot render. Takes and releases the same lock as a stateful
// session, so it cannot smuggle a second Chromium past an owner.
async function doBrowse(args) {
  const o = requireOwner(args);
  if (o.error) return noOwner(o.error);
  const got = acquireLock(o.owner);
  if (!got.ok) return got.error ? { ok: false, refused: "lock_error", error: got.error } : heldBy(got.held);
  const rest = strip(args);
  try {
    if (session.browser && actor) {
      // live session owned by us: reuse its tab by navigating in place
      const res = await actorCall({ cmd: "open", ...rest });
      if (res && res.ok) touchIdle();
      else markFailed();
      return { session_id: session.id, owner: o.owner, reused: true, ...res };
    }
    const opened = await doOpen({ ...rest, owner: o.owner });
    if (opened && opened.ok) {
      await doClose({ owner: o.owner });
      return { reused: false, released: true, ...opened };
    }
    releaseLock();
    return { reused: false, ...opened };
  } catch (e) {
    releaseLock();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// MCP plumbing (same shape as mcp-web-tools/server.mjs)
// ---------------------------------------------------------------------------

function send(msg) { try { process.stdout.write(JSON.stringify(msg) + "\n"); } catch {} }
function result(id, r) { send({ jsonrpc: "2.0", id, result: r }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

const OWNER_PROP = {
  type: "string",
  description:
    "Declared owner of the browser session: your DSH session id, or your name/role in an agent team. " +
    "Required on every tool that touches the browser. One session may be held at a time; a call whose owner " +
    "does not match the holder is refused before any browser starts.",
};

const TOOLS = [
  {
    name: "status",
    description:
      "Report the browser session gate: whether a session is open, who owns it, and its remaining idle time. " +
      "Read-only, needs no owner, starts nothing. Call this first when a browser call was refused.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browse",
    description:
      "Open a URL in a real headless Chromium (stealth flags, warm profile) and return the JS-RENDERED page title and visible text, optionally saving a screenshot. " +
      "Use for pages that need JavaScript or that block plain fetchers (Cloudflare etc.). Slower (~5-25s) than web_extract/fetch_raw — prefer those for static pages. " +
      "Requires `owner`; the render takes the single-session gate and releases it on return. " +
      "If YOUR owner already has a stateful session it navigates that tab instead; if another owner holds it, the call is refused with no browser started.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL" },
        owner: OWNER_PROP,
        wait_ms: { type: "number", description: "Extra render wait after load (default 3500)" },
        max_chars: { type: "number", description: "Max returned text chars (default 20000)" },
        screenshot_path: { type: "string", description: "Optional absolute .png path to save a viewport screenshot" },
      },
      required: ["url", "owner"],
    },
  },
  {
    name: "open",
    description:
      "Open a URL in the browser session (proot Chromium, stealth flags, warm profile) UNDER A DECLARED OWNER. " +
      "Exactly one browser session may exist at a time across all DSH sessions: if another owner holds it this call " +
      "is refused (refused:\"held_by\", names the holder) and no browser is started. Calls carrying your own owner " +
      "continue the same session. Returns title + visible text (JS-rendered). The session auto-closes after an idle " +
      "period (default 10 min, clamped 30 s..30 min) — every open/act call resets it. Close it when done.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to open" },
        owner: OWNER_PROP,
        wait_ms: { type: "number", description: "Extra render wait after load (default 3500)" },
        max_chars: { type: "number", description: "Max returned text chars (default 20000)" },
        screenshot_path: { type: "string", description: "Optional .png path; result reports where it was saved" },
        idle_ms: { type: "number", description: "Idle auto-close for this session in ms (default 600000, min 30000, max 1800000)" },
      },
      required: ["owner"],
    },
  },
  {
    name: "act",
    description:
      "Run interaction/read steps against the current session page (implicit open if a url is given and no session exists). " +
      "Requires the `owner` that holds (or will claim) the session; a mismatched owner is refused before anything runs. " +
      "Steps run sequentially; the first failing step aborts the chain and reports per-step results. " +
      "Pointer input is TRUSTED CDP Input.*; set synthetic:true on a step to use DOM dispatchEvent instead " +
      "(for apps whose handlers only fire on JS-triggered events). eval requires an exact-match allowed_evals " +
      "entry or allow_any_eval:true (default deny).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Optional URL for implicit first open" },
        owner: OWNER_PROP,
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
      required: ["steps", "owner"],
    },
  },
  {
    name: "close",
    description:
      "Close the browser session you own: stops Chromium via CDP and releases the single-session gate. " +
      "Refused if another owner holds the session — there is no preemption, and this tool never signals a process " +
      "it does not own. Idempotent when nothing is open. Strongly suggested once your work is done: it frees " +
      "~800 MB immediately instead of waiting for the idle timer.",
    inputSchema: {
      type: "object",
      properties: { owner: OWNER_PROP },
      required: ["owner"],
    },
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
    case "status": return serialized(() => doStatus());
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
        serverInfo: { name: "browser", version: "3.0.0" },
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
  releaseLock();   // synchronous: runs even if the actor teardown below stalls
  teardown()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});

process.on("exit", () => {
  // Last-resort release for a kill that skipped the signal handlers. Safe: this
  // only removes a record naming THIS pid, and other servers already ignore a
  // record whose pid is gone (liveness proof), so a SIGKILL cannot leave the
  // browser locked either way.
  try {
    const rec = lockRecord();
    if (!rec || rec.pid === process.pid) rmSync(LOCK_FILE, { force: true });
  } catch {}
});
process.on("SIGINT", () => { releaseLock(); teardown().then(() => process.exit(0)); });
process.on("SIGTERM", () => { releaseLock(); teardown().then(() => process.exit(0)); });
