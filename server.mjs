// Run Degree Flow on your own computer: `npm start`, then open http://localhost:3000
// Serves the public/ folder and the same AI endpoint Netlify uses (netlify/functions/claude.mjs).
// Put ANTHROPIC_API_KEY in a .env file next to this one to turn the AI reader on.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

// Minimal .env loader, so no extra packages are needed.
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

const { default: claude } = await import("./netlify/functions/claude.mjs");
const PUBLIC = join(root, "public");
const PORT = Number(process.env.PORT || 3000);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon",
};
const MAX_BODY = 40 * 1024 * 1024;

async function handleApi(req, res) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) { res.writeHead(413, { "content-type": "application/json" }); res.end('{"code":"image_rejected","error":"Upload too large"}'); return; }
    chunks.push(c);
  }
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
  });
  const response = await claude(request, { ip: req.socket.remoteAddress });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

async function handleStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  if (!path || path.endsWith("/")) path += "index.html";
  const file = join(PUBLIC, path);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end("Forbidden"); }
  try {
    if (!(await stat(file)).isFile()) throw 0;
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  const go = req.url.startsWith("/api/claude") ? handleApi : handleStatic;
  go(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end('{"code":"upstream_error","error":"Server error"}');
  });
});

server.listen(PORT, () => {
  console.log(`Degree Flow is running at http://localhost:${PORT}`);
  console.log(process.env.ANTHROPIC_API_KEY ? `AI reader: on (${process.env.CLAUDE_MODEL || "claude-sonnet-5-5"})` : "AI reader: off. Add ANTHROPIC_API_KEY to a .env file to turn it on.");
});
