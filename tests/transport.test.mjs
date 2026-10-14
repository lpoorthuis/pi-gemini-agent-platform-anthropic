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
  assert.throws(() => send(provider, "claude-sonnet-4-6", { apiKey: undefined }), /\/login agent-platform-anthropic/);
});
