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

const storedCredential = {
  type: "oauth", refresh: "/unused/key.json", access: "ya29.stored", expires: Date.now() + 3600_000,
  projectId: "sa-project", location: "eu", clientEmail: "sa@example.com",
};
const priced = (value) => Math.round(value * 1.1 * 1e9) / 1e9;

async function createRuntime(modelsStore = new InMemoryModelsStore()) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(providerId, async () => storedCredential);
  return ModelRuntime.create({ credentials, modelsStore, modelsPath: null, refreshOnCreate: false });
}

const futureModel = () => ({
  ...getBuiltinModels("anthropic")[0], id: "claude-future-9", name: "Claude Future 9",
});

test("session start never re-registers; live catalog is priced in the real runtime", async () => {
  const { provider, registrations, fireSessionStart } = load();
  const runtime = await createRuntime();
  runtime.registerProvider(providerId, provider);
  await runtime.refresh({ providers: [providerId], allowNetwork: false });
  const base = getBuiltinModels("anthropic").find((m) => m.id === "claude-sonnet-4-6");
  assert.equal(runtime.getModel(providerId, "claude-sonnet-4-6").cost.input, priced(base.cost.input));

  const other = { ...futureModel(), id: "gpt-x", provider: "openai", api: "openai-responses" };
  fireSessionStart([futureModel(), other]);
  await runtime.refresh({ providers: [providerId], allowNetwork: false });

  assert.equal(registrations.length, 1);
  assert.equal(runtime.getModel(providerId, "claude-sonnet-4-6").cost.input, priced(base.cost.input));
  const future = runtime.getModel(providerId, "claude-future-9");
  assert.ok(future);
  assert.equal(future.cost.input, priced(futureModel().cost.input));
  assert.equal(runtime.getModel(providerId, "gpt-x"), undefined);
});

test("persisted catalog restores remote-only models on a fresh load without session start", async () => {
  const modelsStore = new InMemoryModelsStore();
  const first = load();
  const firstRuntime = await createRuntime(modelsStore);
  firstRuntime.registerProvider(providerId, first.provider);
  first.fireSessionStart([futureModel()]);
  await firstRuntime.refresh({ providers: [providerId], allowNetwork: false });

  const second = load();
  const secondRuntime = await createRuntime(modelsStore);
  secondRuntime.registerProvider(providerId, second.provider);
  await secondRuntime.refresh({ providers: [providerId], allowNetwork: false });
  assert.ok(secondRuntime.getModel(providerId, "claude-future-9"));
  assert.ok(secondRuntime.getModel(providerId, "claude-sonnet-4-6"));
  assert.equal(second.registrations.length, 1);
});

test("persisted catalogs using the legacy API identity still restore remote-only models", async () => {
  const { provider } = load();
  const legacy = { ...futureModel(), provider: providerId, api: "agent-platform-anthropic-api" };
  const models = await provider.refreshModels({
    signal: new AbortController().signal,
    stored: { models: [legacy], checkedAt: 1 },
    publish: async () => assert.fail("offline restoration should not publish a new catalog"),
  });
  const restored = models.find((model) => model.id === legacy.id);
  assert.ok(restored);
  assert.equal(restored.api, undefined, "the restored model inherits the provider's native API");
  assert.equal(provider.api, "anthropic-messages");
});

test("using the native API identity does not reroute the built-in Anthropic provider", async (t) => {
  const { provider } = load();
  const runtime = await createRuntime();
  runtime.registerProvider(providerId, provider);
  await runtime.refresh({ providers: [providerId], allowNetwork: false });
  const native = runtime.getModel("anthropic", "claude-sonnet-4-6");
  let request;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url: String(url), headers: new Headers(init.headers) };
    return okStream();
  });
  const result = await runtime.streamSimple(native, {
    messages: [{ role: "user", content: "ping", timestamp: 0 }],
  }, { apiKey: "sk-ant-offline", maxRetries: 0 }).result();

  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(result.provider, "anthropic");
  assert.equal(new URL(request.url).host, "api.anthropic.com");
  assert.equal(request.headers.get("x-api-key"), "sk-ant-offline");
});

test("firing session start repeatedly causes no extra registrations", () => {
  const { registrations, fireSessionStart } = load();
  fireSessionStart([futureModel()]);
  fireSessionStart([futureModel()], "new");
  assert.equal(registrations.length, 1);
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
