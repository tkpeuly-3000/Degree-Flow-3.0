// OPTIONAL Degree Flow AI helper, OFF by default. The app reads flowcharts without it.
// It only powers typed plan requests ("put Material Science in Spring 2027"), and only when the
// site owner sets DEGREE_FLOW_AI=on. Leave it unset and this endpoint never calls any AI or spends anything.
//
// Two ways to power it when on:
// 1. Netlify AI Gateway (free plan): Netlify injects ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL itself and
//    bills your Netlify credits. Nothing to set up.
// 2. Your own Anthropic key: set ANTHROPIC_API_KEY in Project configuration > Environment variables.
// Optional: CLAUDE_MODEL, HOURLY_LIMIT (default 20 calls per visitor per hour).

const ANTHROPIC_URL = "https://api.anthropic.com";
const usingGateway = () => !!process.env.NETLIFY_AI_GATEWAY_KEY && (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === process.env.NETLIFY_AI_GATEWAY_KEY);
// Haiku costs much less, so free Netlify credits last longer. Override with CLAUDE_MODEL.
const model = () => process.env.CLAUDE_MODEL || (usingGateway() ? "claude-haiku-5-5" : "claude-sonnet-5-5");

/** Key and address pairs to try, best guess first. A rejected key falls through to the next. */
function routes() {
  const env = process.env, out = [];
  if (String(env.DEGREE_FLOW_AI || "").toLowerCase() !== "on") return []; // off unless the owner turns it on
  const add = (key, base) => { if (key && base && !out.some((r) => r.key === key && r.base === base)) out.push({ key, base: base.replace(/\/+$/, "") }); };
  add(env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL);      // Netlify AI Gateway, or a custom address you set
  add(env.ANTHROPIC_API_KEY, ANTHROPIC_URL);                // your own Anthropic key
  add(env.NETLIFY_AI_GATEWAY_KEY, env.ANTHROPIC_BASE_URL);  // gateway key, if yours is set but not valid
  return out;
}
let working = null; // remember the route that worked
const HOURLY_LIMIT = Number(process.env.HOURLY_LIMIT || 20);
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // base64 length cap per image
const MAX_TOTAL_IMAGE_BYTES = 4.5 * 1024 * 1024; // Netlify rejects request bodies over 6 MB
const MAX_PROMPT = 120000;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const SYSTEM = "You read university degree flowcharts and student planning requests and turn them into exact JSON. Be careful and literal: copy course codes and prerequisite lines exactly as printed, never invent courses, and reply with JSON only.";

const seen = new Map(); // simple limiter (resets when the server restarts)
function limited(ip) {
  const now = Date.now(), hour = 3600_000;
  const list = (seen.get(ip) || []).filter(t => now - t < hour);
  if (list.length >= HOURLY_LIMIT) { seen.set(ip, list); return true; }
  list.push(now); seen.set(ip, list); return false;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req, context) => {
  const ok = routes().length > 0;
  if (req.method === "GET") return json({ ok, model: ok ? model() : null, via: ok ? (usingGateway() ? "netlify" : "anthropic") : null, maxImages: MAX_IMAGES });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!ok) return json({ code: "sampling_disabled", error: "The AI helper is turned off on this site." }, 503);

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "anon";
  if (limited(ip)) return json({ code: "rate_limited", error: "Too many requests. Try again in an hour." }, 429);

  let body;
  try { body = await req.json(); } catch { return json({ code: "invalid_request", error: "Bad JSON" }, 400); }
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";
  const images = Array.isArray(body?.images) ? body.images : [];
  if (!prompt || prompt.length > MAX_PROMPT) return json({ code: "prompt_too_large", error: "Prompt missing or too long" }, 400);
  if (images.length > MAX_IMAGES) return json({ code: "image_rejected", error: `Up to ${MAX_IMAGES} images` }, 400);
  for (const im of images) {
    if (!im || !TYPES.has(im.media_type) || typeof im.data !== "string" || im.data.length > MAX_IMAGE_BYTES)
      return json({ code: "image_rejected", error: "Image type or size not accepted" }, 400);
  }
  if (images.reduce((a, im) => a + im.data.length, 0) > MAX_TOTAL_IMAGE_BYTES)
    return json({ code: "image_rejected", error: "The images are too large together. Use fewer or smaller screenshots." }, 413);

  const content = [
    ...images.map((im, i) => [{ type: "text", text: `Image ${i + 1} of ${images.length}:` }, { type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }]).flat(),
    { type: "text", text: prompt },
  ];

  const payload = JSON.stringify({ model: model(), max_tokens: 16000, temperature: 0, stream: true, system: SYSTEM, messages: [{ role: "user", content }] });
  const all = routes(), same = (a, b) => a && b && a.key === b.key && a.base === b.base;
  const remembered = all.find((r) => same(r, working));
  const tries = remembered ? [remembered, ...all.filter((r) => r !== remembered)] : all;
  let upstream = null;
  for (const r of tries) {
    try {
      upstream = await fetch(`${r.base}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": r.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: payload,
      });
    } catch {
      upstream = null;
      continue;
    }
    if (upstream.status !== 401 && upstream.status !== 403) { working = r; break; }
    console.error(`Key rejected at ${r.base}, trying the next option`);
  }
  if (!upstream) return json({ code: "upstream_error", error: "Couldn't reach Claude" }, 502);
  if (!upstream.ok) {
    let detail = ""; try { detail = (await upstream.json())?.error?.message || ""; } catch {}
    console.error("Anthropic error", upstream.status, detail);
    const s = upstream.status;
    // Tell the page exactly what went wrong, so the site owner can fix it.
    const code =
      s === 401 || s === 403 ? "bad_key" :
      s === 400 && /credit|billing|balance/i.test(detail) ? "no_credits" :
      s === 404 ? "bad_model" :
      s === 413 ? "image_rejected" :
      s === 429 || s === 529 ? "rate_limited" :
      s === 400 ? "invalid_request" : "upstream_error";
    return json({ code, error: detail.slice(0, 300) || `Claude returned status ${s}`, status: s }, code === "rate_limited" ? 429 : 502);
  }

  // Turn Anthropic's event stream into plain text so the browser just reads the answer.
  const enc = new TextEncoder(), dec = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const evt = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = evt.split("\n").find(l => l.startsWith("data:"));
            if (!line) continue;
            let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
            if (d.type === "content_block_delta" && d.delta?.type === "text_delta") controller.enqueue(enc.encode(d.delta.text));
            if (d.type === "error") controller.enqueue(enc.encode("\n[[DF_ERROR:upstream_error]]"));
            if (d.type === "message_delta" && d.delta?.stop_reason === "max_tokens") controller.enqueue(enc.encode("\n[[DF_ERROR:invalid_json]]"));
          }
        }
      } catch {
        controller.enqueue(enc.encode("\n[[DF_ERROR:upstream_error]]"));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/api/claude" };
