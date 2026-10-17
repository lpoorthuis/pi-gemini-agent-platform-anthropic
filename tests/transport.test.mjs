import assert from "node:assert/strict";
import { test } from "node:test";
import { load, modelFor, okStream, requestAuth, userTurn } from "./helpers.mjs";

function capture(t, respond = () => okStream()) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const headers = new Headers(init.headers);
    requests.push({ url: String(url), headers, body: JSON.parse(init.body) });
    return respond(requests.length);
  });
  return requests;
}

const send = (provider, id, options = {}) =>
  provider.streamSimple(modelFor(provider, id), userTurn, { apiKey: requestAuth(), maxRetries: 0, ...options }).result();

test("rewrites pi's Anthropic request for Agent Platform streamRawPredict", async (t) => {
  const { provider } = load();
  const requests = capture(t);
  const result = await send(provider, "claude-sonnet-4-6");
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(result.content, [{ type: "text", text: "pong" }]);
  const [request] = requests;
  assert.equal(
    request.url,
    "https://aiplatform.eu.rep.googleapis.com/v1/projects/sa-project/locations/eu/publishers/anthropic/models/claude-sonnet-4-6:streamRawPredict",
  );
  assert.equal(request.headers.get("authorization"), "Bearer ya29.token");
  assert.equal(request.headers.get("x-api-key"), null);
  assert.equal(request.body.anthropic_version, "vertex-2023-10-16");
  assert.equal(request.body.model, undefined, "Agent Platform takes the model from the URL");
  assert.equal(request.body.stream, true);
});

test("serializes stable request fields before changing message history", async (t) => {
  const { provider } = load();
  const requests = capture(t);
  const result = await provider.streamSimple(modelFor(provider, "claude-sonnet-4-6"), {
    messages: [
      {
        role: "system", content: "Stable instructions", timestamp: 0,
        toolsAdded: [{
          name: "lookup", description: "Stable tool definition",
          parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        }],
      },
      ...userTurn.messages,
    ],
  }, { apiKey: requestAuth(), maxRetries: 0 }).result();

  assert.equal(result.stopReason, "stop", result.errorMessage);
  const body = requests[0].body;
  assert.equal(Object.keys(body).at(-1), "messages", "Google cache reuse is sensitive to top-level wire order");
  assert.equal(body.system[0].text, "Stable instructions");
  assert.equal(body.tools[0].name, "lookup");
  assert.deepEqual(body.messages[0].content[0].text, "ping");
  assert.equal(body.anthropic_version, "vertex-2023-10-16");
  assert.equal(body.model, undefined);
});

test("wire reordering preserves payload values across top-level insertion orders", async (t) => {
  const { provider } = load();
  const requests = capture(t);
  const payload = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: [{ type: "text", text: "Grüße \\\"quoted\\\"\\nline 2", cache_control: { type: "ephemeral" } }] }],
    metadata: { user_id: "synthetic-user" },
    max_tokens: 4096, stream: true,
    system: [{ type: "text", text: "Stable prefix", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "lookup", description: "Lookup", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }],
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "low" },
  };
  const entries = Object.entries(payload);
  const orders = [entries, [...entries].reverse(), [...entries.slice(3), ...entries.slice(0, 3)]];
  const before = structuredClone(payload);
  const { model: _model, ...rest } = payload;
  const expected = { ...rest, anthropic_version: "vertex-2023-10-16" };
  for (const order of orders) {
    const result = await send(provider, payload.model, { onPayload: () => Object.fromEntries(order) });
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(requests.at(-1).body, expected);
    assert.equal(Object.keys(requests.at(-1).body).at(-1), "messages");
  }
  assert.deepEqual(payload, before);
});

test("dated model IDs use the publisher @date form", async (t) => {
  const { provider } = load();
  const requests = capture(t);
  await send(provider, "claude-haiku-4-5-20251001");
  assert.match(decodeURIComponent(requests[0].url), /models\/claude-haiku-4-5@20251001:streamRawPredict$/);
});

test("falls back from multi-region to regional on 404 and 429, then surfaces the error", async (t) => {
  const { provider } = load();
  let requests = capture(t, (n) => (n === 1 ? new Response("quota", { status: 429 }) : okStream()));
  assert.equal((await send(provider, "claude-opus-5")).stopReason, "stop");
  assert.deepEqual(requests.map((r) => new URL(r.url).host), [
    "aiplatform.eu.rep.googleapis.com", "europe-west1-aiplatform.googleapis.com",
  ]);

  t.mock.restoreAll();
  requests = capture(t, () => new Response("not found", { status: 404 }));
  const failed = await send(provider, "claude-opus-5");
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage, /404/);
  assert.equal(requests.length, 2);
});

test("global location uses the global endpoint only", async (t) => {
  const { provider } = load();
  const requests = capture(t, () => new Response("quota", { status: 429 }));
  await send(provider, "claude-opus-5", { apiKey: requestAuth("global") });
  assert.deepEqual(requests.map((r) => r.url.split("/publishers")[0]), [
    "https://aiplatform.googleapis.com/v1/projects/sa-project/locations/global",
  ]);
});

test("missing credentials point to /login without network access", async (t) => {
  const { provider } = load();
  t.mock.method(globalThis, "fetch", () => assert.fail("no request without credentials"));
  assert.throws(() => send(provider, "claude-sonnet-4-6", { apiKey: undefined }), /\/login gemini-agent-platform-anthropic/);
});
