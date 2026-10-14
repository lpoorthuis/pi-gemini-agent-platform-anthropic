import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { load, okStream, providerId } from "./helpers.mjs";

test("startup models are pi's bundled Anthropic catalog, unchanged", () => {
  const { provider } = load();
  const bundled = getBuiltinModels("anthropic");
  assert.deepEqual(provider.models.map((m) => m.id), bundled.map((m) => m.id));
  const opus = provider.models.find((m) => m.id === "claude-opus-5");
  const source = bundled.find((m) => m.id === "claude-opus-5");
  assert.deepEqual(opus.compat, source.compat);
  assert.deepEqual(opus.thinkingLevelMap, source.thinkingLevelMap);
  assert.equal(opus.contextWindow, source.contextWindow);
  assert.equal(opus.provider, undefined);
  assert.equal(opus.baseUrl, undefined);
});

test("session start adopts pi's refreshed Anthropic catalog, ignoring other providers", () => {
  const future = { ...getBuiltinModels("anthropic")[0], id: "claude-future-9", name: "Claude Future 9" };
  const other = { ...future, id: "gpt-x", provider: "openai", api: "openai-responses" };
  const { provider, registrations } = load([future, other]);
  assert.equal(registrations.length, 2);
  assert.deepEqual(provider.models.map((m) => m.id), ["claude-future-9"]);
});

test("costs follow the logged-in location: +10% for eu/us, list price for global", () => {
  const { provider } = load();
  const model = { ...getBuiltinModels("anthropic").find((m) => m.id === "claude-opus-5"), provider: providerId };
  const [eu] = provider.oauth.modifyModels([model], { location: "eu" });
  const [global] = provider.oauth.modifyModels([model], { location: "global" });
  assert.equal(eu.cost.input, Math.round(model.cost.input * 1.1 * 1e9) / 1e9);
  assert.equal(global.cost.input, model.cost.input);
});

test("real pi runtime: stored service-account credential drives inference end to end", async (t) => {
  const { provider } = load();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(providerId, async () => ({
    type: "oauth", refresh: "/unused/key.json", access: "ya29.stored", expires: Date.now() + 3600_000,
    projectId: "sa-project", location: "eu", clientEmail: "sa@example.com",
  }));
  const runtime = await ModelRuntime.create({
    credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false,
  });
  runtime.registerProvider(providerId, provider);
  await runtime.refresh({ providers: [providerId], allowNetwork: false });

  const model = runtime.getModel(providerId, "claude-sonnet-4-6");
  assert.ok(model);
  assert.ok((await runtime.getAvailable(providerId)).some((m) => m.id === model.id));
  const base = getBuiltinModels("anthropic").find((m) => m.id === model.id);
  assert.equal(model.cost.input, Math.round(base.cost.input * 1.1 * 1e9) / 1e9);

  let request;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url: String(url), auth: new Headers(init.headers).get("authorization") };
    return okStream();
  });
  const result = await runtime.complete(model, { messages: [{ role: "user", content: "ping", timestamp: 0 }] });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(request.auth, "Bearer ya29.stored");
  assert.match(request.url, /\/projects\/sa-project\/locations\/eu\//);
});
