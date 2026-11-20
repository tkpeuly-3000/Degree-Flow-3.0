// Netlify's AI Gateway injects ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL. Its key only works at the
// gateway address, and Anthropic rejects it. These tests copy that setup with a fake network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const GATEWAY = "https://degree-flow.netlify.app/.netlify/ai";
const calls = [];
let ownKeyValid = true;
globalThis.fetch = async (url, opts) => {
  const key = opts.headers["x-api-key"];
  calls.push({ url: String(url), key, model: JSON.parse(opts.body).model });
  const valid = String(url).startsWith(GATEWAY) ? key === "gateway-key" : key === "own-key" && ownKeyValid;
  if (!valid) return new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
  const enc = new TextEncoder();
  const ev = `event: x\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: '{"ok":true}' } })}\n\n`;
  return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(ev)); c.close(); } }), { status: 200 });
};
const { default: handler } = await import("../netlify/functions/claude.mjs");
let n = 0;
const post = () => handler(new Request("http://x/api/claude", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }), { ip: `1.1.1.${++n}` });
const setEnv = (vars) => {
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "NETLIFY_AI_GATEWAY_KEY", "CLAUDE_MODEL"]) delete process.env[k];
  Object.assign(process.env, { DEGREE_FLOW_AI: "on" }, vars);
};
beforeEach(() => { calls.length = 0; ownKeyValid = true; });

test("Netlify free plan: uses the injected gateway key at the gateway address, with the cheaper model", async () => {
  setEnv({ ANTHROPIC_API_KEY: "gateway-key", ANTHROPIC_BASE_URL: GATEWAY, NETLIFY_AI_GATEWAY_KEY: "gateway-key" });
  const info = await (await handler(new Request("http://x/api/claude"), {})).json();
  assert.equal(info.ok, true);
  assert.equal(info.via, "netlify");
  assert.equal(info.model, "claude-haiku-5-5");
  const r = await post();
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{"ok":true}');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(GATEWAY));
});

test("own Anthropic key: goes straight to Anthropic with Sonnet", async () => {
  setEnv({ ANTHROPIC_API_KEY: "own-key", NETLIFY_AI_GATEWAY_KEY: "gateway-key" });
  const r = await post();
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1).url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls.at(-1).model, "claude-sonnet-5-5");
});

test("own key plus a stray gateway address still works", async () => {
  setEnv({ ANTHROPIC_API_KEY: "own-key", ANTHROPIC_BASE_URL: GATEWAY, NETLIFY_AI_GATEWAY_KEY: "gateway-key" });
  const r = await post();
  assert.equal(r.status, 200);
  assert.ok(calls.some((c) => c.url === "https://api.anthropic.com/v1/messages" && c.key === "own-key"));
});

test("a broken own key falls back to the free gateway", async () => {
  setEnv({ ANTHROPIC_API_KEY: "own-key", ANTHROPIC_BASE_URL: GATEWAY, NETLIFY_AI_GATEWAY_KEY: "gateway-key" });
  ownKeyValid = false;
  const r = await post();
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1).key, "gateway-key");
});

test("CLAUDE_MODEL overrides the model", async () => {
  setEnv({ ANTHROPIC_API_KEY: "gateway-key", ANTHROPIC_BASE_URL: GATEWAY, NETLIFY_AI_GATEWAY_KEY: "gateway-key", CLAUDE_MODEL: "claude-sonnet-5-5" });
  await post();
  assert.equal(calls.at(-1).model, "claude-sonnet-5-5");
});

test("AI stays off unless the owner sets DEGREE_FLOW_AI=on, even when Netlify provides a key", async () => {
  setEnv({ ANTHROPIC_API_KEY: "gateway-key", ANTHROPIC_BASE_URL: GATEWAY, NETLIFY_AI_GATEWAY_KEY: "gateway-key" });
  delete process.env.DEGREE_FLOW_AI;
  const info = await (await handler(new Request("http://x/api/claude"), {})).json();
  assert.equal(info.ok, false);
  const before = calls.length;
  assert.equal((await post()).status, 503);
  assert.equal(calls.length, before, "no AI call was made");
});
