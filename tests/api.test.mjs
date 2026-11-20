// Tests the AI endpoint with a fake Anthropic API, so no key or network is needed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DEGREE_FLOW_AI = "on";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.HOURLY_LIMIT = "5";
const { default: handler } = await import("../netlify/functions/claude.mjs");

let lastBody = null, mode = "ok";
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes("api.anthropic.com")) return realFetch(url, opts);
  lastBody = JSON.parse(opts.body);
  if (mode === "overloaded") return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 529 });
  if (mode === "badkey") return new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
  if (mode === "nocredit") return new Response(JSON.stringify({ error: { message: "Your credit balance is too low to access the Anthropic API." } }), { status: 400 });
  if (mode === "badmodel") return new Response(JSON.stringify({ error: { message: "model: not found" } }), { status: 404 });
  const text = '{"courses":[{"code":"ME 3370","name":"Fluids"}]}';
  const enc = new TextEncoder();
  const events = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    ...text.match(/.{1,7}/g).map((t) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: t } })}\n\n`),
    mode === "cutoff" ? 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n' : "",
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  return new Response(new ReadableStream({ start(c) { events.forEach((e) => e && c.enqueue(enc.encode(e))); c.close(); } }), { status: 200 });
};

let ipCounter = 0;
const post = (body, ip = `10.0.0.${++ipCounter}`) => handler(new Request("http://x/api/claude", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { ip });
const tiny = { media_type: "image/png", data: "iVBORw0KGgo=" };
beforeEach(() => { mode = "ok"; lastBody = null; });

test("GET reports the AI as available", async () => {
  const r = await handler(new Request("http://x/api/claude"), {});
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.maxImages, 6);
});

test("POST streams Claude's text back and sends images first", async () => {
  const r = await post({ prompt: "read this", images: [tiny, tiny] });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{"courses":[{"code":"ME 3370","name":"Fluids"}]}');
  const content = lastBody.messages[0].content;
  assert.equal(content.filter((c) => c.type === "image").length, 2);
  assert.equal(content.at(-1).text, "read this");
  assert.equal(lastBody.stream, true);
});

test("an answer cut off by the length limit is flagged", async () => {
  mode = "cutoff";
  const text = await (await post({ prompt: "x" })).text();
  assert.match(text, /\[\[DF_ERROR:invalid_json\]\]/);
});

test("bad requests are rejected before reaching Claude", async () => {
  assert.equal((await post({ prompt: "" })).status, 400);
  assert.equal((await post({ prompt: "x", images: Array(7).fill(tiny) })).status, 400);
  assert.equal((await post({ prompt: "x", images: [{ media_type: "text/html", data: "aa" }] })).status, 400);
  assert.equal(lastBody, null);
});

test("Claude being overloaded comes back as rate_limited", async () => {
  mode = "overloaded";
  const r = await post({ prompt: "x" });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, "rate_limited");
});

test("each visitor is limited per hour", async () => {
  const ip = "9.9.9.9";
  for (let i = 0; i < 5; i++) assert.equal((await post({ prompt: "x" }, ip)).status, 200);
  const r = await post({ prompt: "x" }, ip);
  assert.equal(r.status, 429);
});

test("without a key the endpoint says the AI is off", async () => {
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const d = await (await handler(new Request("http://x/api/claude"), {})).json();
  assert.equal(d.ok, false);
  assert.equal((await post({ prompt: "x" })).status, 503);
  process.env.ANTHROPIC_API_KEY = key;
});

test("a wrong API key, no credits and a bad model name each get their own error", async () => {
  for (const [m, code] of [["badkey", "bad_key"], ["nocredit", "no_credits"], ["badmodel", "bad_model"]]) {
    mode = m;
    const r = await post({ prompt: "x" });
    const d = await r.json();
    assert.equal(r.status, 502);
    assert.equal(d.code, code, m);
    assert.ok(d.error.length > 0, "includes Claude's own message");
  }
});

test("images too big together are rejected before reaching Claude", async () => {
  const big = { media_type: "image/jpeg", data: "A".repeat(1.6 * 1024 * 1024) };
  const r = await post({ prompt: "x", images: [big, big, big] });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).code, "image_rejected");
  assert.equal(lastBody, null);
});
