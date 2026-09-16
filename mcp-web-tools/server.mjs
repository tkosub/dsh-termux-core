// web-tools — minimal zero-dependency MCP stdio server exposing local search
// and extraction as native agent tools:
//   mcp__web__searxng_search  — metasearch via the local searXNG instance
//   mcp__web__extract         — main-content extraction via trafilatura
//   mcp__web__fetch_raw       — raw HTML fetch (JS-heavy/blocked pages: use
//                               mcp__browser__browse instead)
// Framing: newline-delimited JSON-RPC 2.0 over stdin/stdout (MCP stdio).
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const SEARXNG_URL = process.env.SEARXNG_URL || "http://127.0.0.1:8888";
const VERSION = "2024-11-05";
const SERVER_INFO = { name: "web-tools", version: "1.1.0" };

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function result(id, r) { send({ jsonrpc: "2.0", id, result: r }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function curlText(url, { timeoutMs = 20000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-sSL", "-m", String(Math.ceil(timeoutMs / 1000)), "--"];
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    args.push(url);
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(err.trim() || `curl exit ${code}`)));
  });
}


async function searxngSearch(query, maxResults = 8) {
  const u = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
  const raw = await curlText(u, { timeoutMs: 15000 });
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`searXNG returned non-JSON: ${raw.slice(0, 200)}`); }
  const results = (data.results || []).slice(0, Math.max(1, Math.min(25, maxResults)))
    .map((r) => ({ title: r.title, url: r.url, snippet: r.content || "", engine: r.engine }));
  if (!results.length) return `No results for: ${query}`;
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
}

function trafilaturaExtract(html, url) {
  return new Promise((resolve, reject) => {
    const py = [
      "import sys, trafilatura",
      "html = sys.stdin.read()",
      "out = trafilatura.extract(html, url=" + JSON.stringify(url) +
        ", include_comments=False, include_links=False, output_format='markdown', favor_recall=True)",
      "sys.stdout.write(out or '')",
    ].join("\n");
    const child = spawn("python3", ["-c", py], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", () => out.trim() ? resolve(out) : reject(new Error(err.trim() || "trafilatura produced no content")));
    child.stdin.end(html);
  });
}

async function extractUrl(url) {
  const html = await curlText(url, { timeoutMs: 25000, headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" } });
  try {
    return await trafilaturaExtract(html, url);
  } catch (e) {
    return `trafilatura failed (${e.message}); raw HTML follows:\n\n` + html.slice(0, 4000);
  }
}

async function fetchRaw(url) {
  const html = await curlText(url, { timeoutMs: 25000, headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" } });
  return html.slice(0, 20000) + (html.length > 20000 ? `\n\n[truncated, ${html.length} bytes total]` : "");
}

const TOOLS = [
  {
    name: "searxng_search",
    description: "Web metasearch through the local private searXNG instance (Google/Bing/DDG/etc. aggregated). Returns ranked title/url/snippet lines.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Max results (default 8, cap 25)" },
      },
      required: ["query"],
    },
  },
  {
    name: "extract",
    description: "Fetch a web page and extract its main readable content as markdown using trafilatura. Best default for reading an article/page found via search.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http(s) URL" } },
      required: ["url"],
    },
  },
  {
    name: "fetch_raw",
    description: "Fetch a URL and return the first ~20KB of raw HTML. For JS-rendered or bot-blocked pages prefer mcp__browser__browse instead.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http(s) URL" } },
      required: ["url"],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "searxng_search": return searxngSearch(String(args.query), Number(args.max_results ?? 8));
    case "extract": return extractUrl(String(args.url));
    case "fetch_raw": return fetchRaw(String(args.url));
    default: throw new Error(`unknown tool: ${name}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  const { id, method, params } = msg;
  if (method === undefined) return;
  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;
    case "ping":
      result(id, {});
      break;
    case "tools/list":
      result(id, { tools: TOOLS });
      break;
    case "tools/call": {
      const tname = String(params?.name ?? "");
      callTool(tname, params?.arguments ?? {})
        .then((text) => result(id, { content: [{ type: "text", text }] }))
        .catch((e) => result(id, { content: [{ type: "text", text: `error: ${e.message}` }], isError: true }));
      break;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      break;
    default:
      if (id !== undefined) error(id, -32601, `method not found: ${method}`);
  }
});
