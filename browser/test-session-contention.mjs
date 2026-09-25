// test-session-contention.mjs — REAL end-to-end check of the browser gate.
//
// Unlike test-session-gate.mjs this boots a REAL proot Chromium through the real
// python actor, so it proves the two properties that actually matter:
//
//   1. a second owner is refused WITHOUT a second Chromium being started
//   2. closing leaves no Chromium behind (the lock is never held by an orphan)
//
// It uses its own run directory (so the live gate file is untouched) but the
// SHARED browser profile, so do not run it while another browser session is open.
//
// Usage: node test-session-contention.mjs [url]
// Exit 0 = all checks passed.

import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVER = join(HERE, "session_server.mjs");
const SERVE = join(HERE, "session_serve.py");
const URL1 = process.argv[2] || "https://example.com";
const PROFILE_SUBSTR = process.env.BROWSER_SESSION_PROFILE_SUBSTR || "browser-session/user-data";

const SANDBOX = mkdtempSync(join(tmpdir(), "gate-real-"));
const RUN = join(SANDBOX, "run");
const LOCK = join(RUN, "browser-session.lock");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
};

// count top-level proot Chromium sessions (never the --type= helpers)
function browserSessions() {
  const found = [];
  for (const entry of readdirSyncSafe("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let argv;
    try { argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { continue; }
    if (!argv.length || !argv[0].endsWith("/chromium")) continue;
    if (argv.some((a) => a.startsWith("--type="))) continue;
    if (!argv.some((a) => a.includes(PROFILE_SUBSTR))) continue;
    found.push(entry);
  }
  return found;
}
function readdirSyncSafe(p) { try { return readdirSync(p); } catch { return []; } }

const child = spawn(process.execPath, [SERVER], {
  cwd: HERE,
  env: { ...process.env, BROWSER_SESSION_SERVE: SERVE, DSH_BROWSER_SESSION_RUN: RUN },
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
child.stderr.on("data", (d) => process.stderr.write(String(d)));
let next = 1;
const rpc = (method, params, timeoutMs = 180_000) => new Promise((resolve, reject) => {
  const id = next++;
  const t = setTimeout(() => { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r?.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text, isError: !!r?.result?.isError }; }
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "contention-test" } });

  const free = await call("status", {});
  check("gate is free to start", free.session_open === false && free.held_by === null, free);
  check("no Chromium running yet", browserSessions().length === 0, browserSessions());

  const t0 = Date.now();
  const a = await call("open", { url: URL1, owner: "owner-alice", wait_ms: 4000 });
  console.log(`  (real boot took ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  check("owner-alice boots a real session", a.ok === true && !!a.title, a);
  check("one real Chromium session exists", browserSessions().length === 1, browserSessions());
  check("lock names owner-alice", (() => { try { return JSON.parse(readFileSync(LOCK, "utf8")).owner === "owner-alice"; } catch { return false; } })());

  const b = await call("open", { url: "https://example.org", owner: "owner-bob" });
  check("owner-bob refused, named holder", b.refused === "held_by" && b.held_by === "owner-alice", b);
  check("refusal named the owning session", !!b.held_session_id, b);
  check("STILL only one Chromium (no second boot)", browserSessions().length === 1, browserSessions());

  const bb = await call("browse", { url: "https://example.org", owner: "owner-bob" });
  check("browse also refused", bb.refused === "held_by", bb);
  check("browse did not start a Chromium either", browserSessions().length === 1, browserSessions());

  const act = await call("act", { owner: "owner-alice", steps: [{ type: "read", selector: "body", mode: "text" }] });
  check("owner-alice can still act", act.ok === true && act.steps?.[0]?.ok === true, act);

  const c = await call("close", { owner: "owner-alice" });
  check("owner-alice closes", c.ok === true, c);
  check("lock file gone", !existsSync(LOCK));

  let left = browserSessions();
  for (let i = 0; i < 40 && left.length; i++) { await new Promise((r) => setTimeout(r, 250)); left = browserSessions(); }
  check("no Chromium left behind (nothing can hold the gate)", left.length === 0, left);

  const st = await call("status", {});
  check("gate reports free after close", st.session_open === false && st.held_by === null, st);

  const c2 = await call("browse", { url: URL1, owner: "owner-carol" });
  check("next owner gets the browser immediately", c2.ok === true && !!c2.title, c2);
  check("browse released it again", !existsSync(LOCK));
  left = browserSessions();
  for (let i = 0; i < 40 && left.length; i++) { await new Promise((r) => setTimeout(r, 250)); left = browserSessions(); }
  check("one-shot browse left nothing running", left.length === 0, left);
} finally {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 1000));
  try { child.kill("SIGKILL"); } catch {}
  rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
