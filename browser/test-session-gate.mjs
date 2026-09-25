// test-session-gate.mjs — offline test for the browser single-session gate.
//
// Runs session_server.mjs against a STUB actor (no Chromium, no network) and
// drives it over stdio like a real MCP client, asserting the ownership rules:
//
//   1. every browser-touching tool refuses without an owner, starting nothing
//   2. the first owner acquires; a different owner is refused, by name
//   3. the same owner continues its own session (open/act/close/browse)
//   4. only the owner may close
//   5. browse takes the gate and gives it back
//   6. status is readable without an owner and names the holder
//   7. a lock record is honoured only while its holder process is alive
//      (real pid + kernel start-time proof), and is taken over once it is not
//
// Usage: node test-session-gate.mjs [path/to/session_server.mjs]
// Exit 0 = all assertions passed.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SERVER = process.argv[2] ?? join(fileURLToPath(new URL(".", import.meta.url)), "session_server.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "gate-test-"));
const RUN = join(SANDBOX, "run");

const STUB = join(SANDBOX, "stub_serve.py");
writeFileSync(STUB, `
import json, sys
def out(o): sys.stdout.write(json.dumps(o) + "\\n"); sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: req = json.loads(line)
    except Exception: continue
    rid, cmd = req.get("id"), req.get("cmd")
    if cmd == "shutdown": out({"id": rid, "ok": True, "bye": True}); break
    if cmd == "open": out({"id": rid, "ok": True, "url": req.get("url"), "title": "stub", "text": "stub page"}); continue
    if cmd == "act": out({"id": rid, "ok": True, "steps": [{"type": s.get("type"), "ok": True} for s in (req.get("steps") or [])]}); continue
    out({"id": rid, "ok": True})
`);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, BROWSER_SESSION_SERVE: STUB, DSH_BROWSER_SESSION_RUN: RUN, PYTHON3: process.env.PYTHON3 || "python3" },
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
  child.stderr.on("data", () => {});   // server logs; irrelevant to assertions
  let next = 1;
  const rpc = (method, params, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const id = next++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  // tools/call returns a JSON string in content[0].text
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r?.result?.content?.[0]?.text ?? "";
    try { return JSON.parse(text); } catch { return { raw: text, isError: !!r?.result?.isError }; }
  };
  return { child, rpc, call, lockFile: join(RUN, "browser-session.lock") };
}

function readLock() { try { return JSON.parse(readFileSync(join(RUN, "browser-session.lock"), "utf8")); } catch { return null; } }
function procStartTicks(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = startServer();
try {
  await s.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gate-test" } });
  const tools = (await s.rpc("tools/list", {})).result.tools;
  console.log("tools/list");
  check("5 tools exposed", tools.length === 5, tools.map((t) => t.name));
  for (const t of ["open", "act", "close", "browse"]) {
    const tool = tools.find((x) => x.name === t);
    check(`${t} requires owner`, tool.inputSchema.required.includes("owner"), tool.inputSchema.required);
  }
  check("status needs no owner", !(tools.find((x) => x.name === "status").inputSchema.required ?? []).includes("owner"));

  console.log("owner declaration");
  check("browse refuses without owner", (await s.call("browse", { url: "http://x" })).refused === "no_owner");
  check("open refuses without owner", (await s.call("open", { url: "http://x" })).refused === "no_owner");
  check("act refuses without owner", (await s.call("act", { steps: [{ type: "read" }] })).refused === "no_owner");
  check("close refuses without owner", (await s.call("close", {})).refused === "no_owner");
  check("nothing acquired by refused calls", !existsSync(s.lockFile));
  check("empty owner refused", (await s.call("open", { url: "http://x", owner: "   " })).refused === "no_owner");

  console.log("free session");
  const st0 = await s.call("status", {});
  check("status: free", st0.session_open === false && st0.held_by === null, st0);
  const o1 = await s.call("open", { url: "http://a", owner: "alice" });
  check("alice acquires", o1.ok === true, o1);
  check("lock names alice + her session", readLock()?.owner === "alice" && !!readLock()?.session_id, readLock());
  check("result echoes owner", o1.owner === "alice", o1);
  const st1 = await s.call("status", {});
  check("status names the holder", st1.session_open === true && st1.held_by?.owner === "alice", st1);
  check("idle timer reported", st1.idle_ms_left > 0, st1);

  console.log("second owner is refused, by name");
  const o2 = await s.call("open", { url: "http://b", owner: "bob" });
  check("open refused", o2.refused === "held_by" && o2.held_by === "alice", o2);
  const a2 = await s.call("act", { owner: "bob", steps: [{ type: "read" }] });
  check("act refused", a2.refused === "held_by" && a2.held_by === "alice", a2);
  const b2 = await s.call("browse", { url: "http://b", owner: "bob" });
  check("browse refused (no smuggled Chromium)", b2.refused === "held_by" && b2.held_by === "alice", b2);
  const c2 = await s.call("close", { owner: "bob" });
  check("close refused (no preemption)", c2.refused === "held_by", c2);
  check("still alice's", readLock()?.owner === "alice", readLock());
  check("refusal says do-not-kill", /Do NOT kill/i.test(o2.guidance ?? ""), o2.guidance);

  console.log("owner keeps its own session");
  const same = await s.call("open", { url: "http://a2", owner: "alice" });
  check("alice may reopen", same.ok === true, same);
  const act3 = await s.call("act", { owner: "alice", steps: [{ type: "read" }, { type: "screenshot" }] });
  check("alice may act", act3.ok === true && act3.steps?.length === 2, act3);
  check("alice keeps one session id", act3.session_id === same.session_id, [act3.session_id, same.session_id]);
  const br4 = await s.call("browse", { url: "http://a3", owner: "alice" });
  check("browse reuses alice's live session", br4.reused === true && br4.ok === true, br4);
  check("reuse did not release the gate", readLock()?.owner === "alice", readLock());

  console.log("release");
  const c5 = await s.call("close", { owner: "alice" });
  check("alice closes", c5.ok === true && c5.closed === true, c5);
  check("lock released", !existsSync(s.lockFile), readLock());
  check("status free again", (await s.call("status", {})).session_open === false);
  const b6 = await s.call("browse", { url: "http://c", owner: "carol" });
  check("browse boots for a free gate", b6.reused === false && b6.ok === true, b6);
  check("browse gave the gate back", !existsSync(s.lockFile), readLock());

  console.log("lock is bound to a live holder process");
  const witness = spawn("sleep", ["30"], { stdio: "ignore" });
  const witnessGone = new Promise((r) => witness.on("exit", r));   // reaped, not just signalled
  await sleep(150);
  const witnessPid = witness.pid, witnessStart = procStartTicks(witnessPid);
  check("witness process is live", witnessStart !== null, witnessPid);
  writeFileSync(s.lockFile, JSON.stringify({ owner: "ghost", pid: witnessPid, started: "2020-01-01T00:00:00.000Z", starttime: witnessStart, session_id: "ghost-sess" }));
  const o7 = await s.call("open", { url: "http://d", owner: "dave" });
  check("a live holder's record is honoured even if it is not ours", o7.refused === "held_by" && o7.held_by === "ghost", o7);
  check("record reports the foreign holder", o7.held_session_id === "ghost-sess", o7);
  witness.kill("SIGKILL");
  for (let i = 0; i < 60 && procStartTicks(witnessPid) !== null; i++) await sleep(100);
  const o8 = await s.call("open", { url: "http://d", owner: "dave" });
  check("dead holder's record is taken over (no permanent lockout)", o8.ok === true, o8);
  const wrongStart = JSON.stringify({ owner: "zombie", pid: process.pid, started: "x", starttime: "999999", session_id: "z" });
  await s.call("close", { owner: "dave" });
  writeFileSync(s.lockFile, wrongStart);
  const o9 = await s.call("open", { url: "http://e", owner: "erin" });
  check("pid reuse with a mismatched start time is not honoured", o9.ok === true, o9);

  console.log("idle clamp");
  const o10 = await s.call("open", { url: "http://f", owner: "erin", idle_ms: 0 });
  const st11 = await s.call("status", {});
  check("idle_ms=0 clamps to the default, not 'never'", o10.ok === true && st11.idle_ms_left > 9 * 60_000, st11);
  await s.call("close", { owner: "erin" });
  const o12 = await s.call("open", { url: "http://g", owner: "erin", idle_ms: 999_999_999 });
  const st13 = await s.call("status", {});
  check("oversized idle clamps to the 30 min cap", o12.ok === true && st13.idle_ms_left <= 30 * 60_000, st13);
  await s.call("close", { owner: "erin" });

  console.log("records that cannot be verified must never lock the gate");
  writeFileSync(s.lockFile, "");                       // what flock(1) leaves behind
  const o14 = await s.call("open", { url: "http://h", owner: "vera" });
  check("an EMPTY record is taken over, not honoured", o14.ok === true, o14);
  await s.call("close", { owner: "vera" });
  writeFileSync(s.lockFile, "{ not json at all");
  const o15 = await s.call("open", { url: "http://h", owner: "vera" });
  check("a GARBAGE record is taken over", o15.ok === true, o15);
  await s.call("close", { owner: "vera" });
  writeFileSync(s.lockFile, JSON.stringify({ owner: "old-build", pid: 1, started: "x" })); // no starttime proof
  const o16 = await s.call("open", { url: "http://h", owner: "vera" });
  check("a record without a start-time proof is taken over", o16.ok === true, o16);
  await s.call("close", { owner: "vera" });
  check("status reports free after the takeovers", (await s.call("status", {})).session_open === false);
} finally {
  s.child.stdin.end();
  await sleep(300);
  try { s.child.kill("SIGKILL"); } catch {}
  rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
