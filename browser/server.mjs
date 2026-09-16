// browser-tools — minimal zero-dependency MCP stdio server exposing the proot
// Debian Chromium (nodriver stealth path) as a native agent tool:
//   mcp__browser__browse — JS-rendered page text (+ optional screenshot file)
// Calls are SERIALIZED (Chromium locks the shared warm user-data-dir); each
// call boots a fresh proot Chromium (~5-20s) and reaps its process tree.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2024-11-05";
const PY = process.env.PYTHON3 || "python3";  // Python with nodriver installed system-wide
const BROWSE = process.env.BROWSER_TOOLS_BROWSE ||
  join(fileURLToPath(new URL(".", import.meta.url)), "browse.py");

function send(msg) { try { process.stdout.write(JSON.stringify(msg) + "\n"); } catch {} }
function result(id, r) { send({ jsonrpc: "2.0", id, result: r }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

let chain = Promise.resolve(); // serialize browser calls

function browse(args) {
  const run = () => new Promise((resolve) => {
    const a = [BROWSE, "--url", String(args.url),
      "--wait-ms", String(Number(args.wait_ms ?? 3500)),
      "--max-chars", String(Number(args.max_chars ?? 20000))];
    if (args.screenshot_path) a.push("--screenshot", String(args.screenshot_path));
    const child = spawn(PY, a, { cwd: fileURLToPath(new URL(".", import.meta.url)) });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: `spawn: ${e.message}` }); });
    child.on("close", () => {
      clearTimeout(timer);
      let parsed = null;
      for (const line of out.trim().split("\n").reverse()) {
        try { parsed = JSON.parse(line); break; } catch {}
      }
      if (!parsed) parsed = { ok: false, error: (err || "no output").slice(0, 500) };
      resolve(parsed);
    });
  });
  chain = chain.then(run, run);
  return chain;
}

const TOOLS = [{
  name: "browse",
  description:
    "Open a URL in a real headless Chromium (stealth flags, warm profile) and return the JS-RENDERED page title and visible text, optionally saving a screenshot. Use for pages that need JavaScript or that block plain fetchers (Cloudflare etc.). Slower (~5-25s) than web_extract/fetch_raw — prefer those for static pages.",
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
}];

async function callTool(name, args) {
  if (name === "browse") return browse(args ?? {});
  throw new Error(`unknown tool: ${name}`);
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
        serverInfo: { name: "browser-tools", version: "1.0.0" },
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
