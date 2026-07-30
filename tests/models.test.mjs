import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import register from "../extensions/agent-platform-anthropic.ts";

const providerId = "agent-platform-anthropic";
const catalogUrl = "https://pi.dev/api/models/providers/anthropic";
const baseModel = {
  id: "claude-future-6", name: "Future Claude", reasoning: true,
  input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000,
  cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5,
    tiers: [{ inputTokensAbove: 200000, input: 8, output: 30, cacheRead: 0.4, cacheWrite: 10 }] },
  thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
  compat: { forceAdaptiveThinking: true, supportsMidConvoSystemMessages: true },
  inputLimits: { images: { resize: { maxWidth: 1568, maxHeight: 1568, maxBytes: 5242880, jpegQuality: 75 } } },
  promptCache: { short: 300, long: 3600 },
};

function setup(t, env = {}) {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(AGENT_PLATFORM_ANTHROPIC_|ANTHROPIC_|GOOGLE_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  let provider;
  register({ on() {}, registerProvider(id, config) { assert.equal(id, providerId); provider = config; } });
  return provider;
}

function refreshContext(overrides = {}) {
  const publications = [];
  return {
    allowNetwork: false, signal: new AbortController().signal,
    async publish(publication) { publications.push(publication); return true; },
    publications, ...overrides,
  };
}

function mockCatalog(t, payload = { [baseModel.id]: baseModel }) {
  return t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, catalogUrl, "Discovery must never contact Google or probe inference");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, undefined);
    return Response.json(payload);
  });
}

async function runtimeFor(config, store = new InMemoryModelsStore()) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: store,
    modelsPath: null, refreshOnCreate: false,
  });
  runtime.registerProvider(providerId, config);
  return runtime;
}
const refresh = (runtime, options = {}) => runtime.refresh({ providers: [providerId], ...options });

test("bundled/offline discovery needs neither project nor ADC nor network", async (t) => {
  const provider = setup(t);
  t.mock.method(globalThis, "fetch", () => assert.fail("offline discovery used network"));
  const models = await provider.refreshModels(refreshContext());
  assert.equal(models.length, getBuiltinModels("anthropic").length);
  const bundled = getBuiltinModels("anthropic").find((model) => model.id === "claude-opus-5");
  const opus = models.find((model) => model.id === bundled.id);
  assert.equal(opus.cost.input, Math.round(bundled.cost.input * 1.1 * 1e9) / 1e9);
  assert.deepEqual(getSupportedThinkingLevels(opus), getSupportedThinkingLevels(bundled));
  assert.ok(opus.inputLimits.images.resize);
  assert.deepEqual(opus.promptCache, { short: 300 });
});

test("refresh uses current stored/publish API and caches unscaled metadata", async (t) => {
  const provider = setup(t);
  mockCatalog(t);
  const context = refreshContext({ allowNetwork: true });
  const [model] = await provider.refreshModels(context);
  assert.equal(model.id, baseModel.id);
  assert.equal(model.cost.input, 4.4);
  assert.equal(model.cost.tiers[0].input, 8.8);
  assert.equal(model.cost.tiers[0].inputTokensAbove, 200000);
  assert.deepEqual(model.inputLimits, baseModel.inputLimits);
  assert.deepEqual(model.thinkingLevelMap, baseModel.thinkingLevelMap);
  assert.deepEqual(model.compat, { forceAdaptiveThinking: true });
  assert.deepEqual(model.promptCache, { short: 300 });
  assert.equal(context.publications.length, 1);
  const stored = context.publications[0].persist;
  assert.equal(stored.models[0].cost.input, 4);
  assert.ok(stored.checkedAt);

  process.env.AGENT_PLATFORM_ANTHROPIC_MULTI_LOCATION = "global";
  let globalProvider;
  register({ on() {}, registerProvider(_id, config) { globalProvider = config; } });
  const [globalModel] = await globalProvider.refreshModels(refreshContext({ stored }));
  assert.equal(globalModel.cost.input, 4);
  assert.equal(globalModel.cost.tiers[0].input, 8);
});

test("fresh cache throttles network; force bypasses it", async (t) => {
  const provider = setup(t);
  const fetch = mockCatalog(t);
  const first = refreshContext({ allowNetwork: true });
  await provider.refreshModels(first);
  const stored = first.publications[0].persist;
  await provider.refreshModels(refreshContext({ allowNetwork: true, stored }));
  assert.equal(fetch.mock.callCount(), 1);
  await provider.refreshModels(refreshContext({ allowNetwork: true, stored, force: true }));
  assert.equal(fetch.mock.callCount(), 2);
  await provider.refreshModels(refreshContext({ allowNetwork: false, stored, force: true }));
  assert.equal(fetch.mock.callCount(), 2);
});

test("exact IDs, aliases, limits and unknown models survive refresh", async (t) => {
  const provider = setup(t, {
    AGENT_PLATFORM_ANTHROPIC_MODELS: "claude-haiku-4.5@20251001,claude-opus-5,custom-model",
    AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS: "claude-haiku-4-5-20251001=250000:32000",
  });
  const haiku = getBuiltinModels("anthropic").find((m) => m.id === "claude-haiku-4-5-20251001");
  mockCatalog(t, [haiku]);
  const models = await provider.refreshModels(refreshContext({ allowNetwork: true }));
  assert.deepEqual(models.map((m) => m.id), ["claude-haiku-4.5@20251001", "claude-opus-5", "custom-model"]);
  assert.equal(models[0].name, haiku.name);
  assert.equal(models[0].contextWindow, 250000);
  assert.equal(models[0].maxTokens, 32000);
  assert.equal(models[1].contextWindow, 1000000, "retain bundled metadata if remote omits an explicit ID");
  assert.equal(models[1].compat.forceAdaptiveThinking, true);
  assert.equal(models[2].contextWindow, 200000);
  assert.equal(models[2].cost.input, 0);
});

test("explicit 1m aliases inherit base metadata but retain the expanded context", async (t) => {
  const provider = setup(t, { AGENT_PLATFORM_ANTHROPIC_MODELS: "claude-haiku-4.5-20251001[1m]" });
  const [model] = await provider.refreshModels(refreshContext());
  assert.equal(model.contextWindow, 1000000);
  assert.equal(model.cost.input, 1.1);
  assert.equal(model.maxTokens, 64000);
});

test("projected models send publisher IDs and current adaptive effort levels", async (t) => {
  const provider = setup(t, {
    GOOGLE_CLOUD_PROJECT: "offline-project", GOOGLE_OAUTH_ACCESS_TOKEN: "offline-token",
  });
  // Include a newer remote-only model so this also runs against the minimum Pi version.
  const catalog = mockCatalog(t, [...getBuiltinModels("anthropic"), { ...baseModel, id: "claude-opus-5-5" }]);
  const models = await provider.refreshModels(refreshContext({ allowNetwork: true }));
  catalog.mock.restore();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
      'data: {"type":"message_stop"}\n\n',
    );
  });
  const send = async (id, options) => {
    const metadata = models.find((m) => m.id === id);
    assert.ok(metadata, id);
    const model = { ...metadata, api: provider.api, baseUrl: provider.baseUrl, provider: providerId };
    const result = await provider.streamSimple(model, {
      messages: [{ role: "user", content: "test", timestamp: 0 }],
    }, options).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    return requests.at(-1);
  };
  const opus = await send("claude-opus-5-5", { reasoning: "max" });
  assert.match(opus.url, /models\/claude-opus-5-5:streamRawPredict$/);
  assert.deepEqual(opus.body.thinking, { type: "adaptive" });
  assert.deepEqual(opus.body.output_config, { effort: "max" });
  const clamped = await send("claude-opus-5-5", { reasoning: "minimal" });
  assert.deepEqual(clamped.body.output_config, { effort: "low" });
  const mandatory = await send("claude-opus-5-5");
  assert.deepEqual(mandatory.body.output_config, { effort: "low" });
  const xhigh = await send("claude-opus-4.8", { reasoning: "xhigh" });
  assert.deepEqual(xhigh.body.output_config, { effort: "xhigh" });
  const haiku = await send("claude-haiku-4.5-20251001", { reasoning: "low" });
  assert.match(decodeURIComponent(haiku.url), /models\/claude-haiku-4-5@20251001:streamRawPredict$/);
  assert.deepEqual(haiku.body.thinking, { type: "enabled", budget_tokens: 4096 });
  assert.match(JSON.stringify(haiku.body), /cache_control/);
  const uncached = await send("claude-opus-5-5", { cacheRetention: "none" });
  assert.doesNotMatch(JSON.stringify(uncached.body), /cache_control/);
});

test("quota errors surface at inference without removing discovered models", async (t) => {
  const provider = setup(t, {
    GOOGLE_CLOUD_PROJECT: "offline-project", GOOGLE_OAUTH_ACCESS_TOKEN: "offline-token",
  });
  const fetch = mockCatalog(t);
  const [metadata] = await provider.refreshModels(refreshContext({ allowNetwork: true }));
  fetch.mock.restore();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    return new Response("Quota not available", { status: 429 });
  });
  const model = { ...metadata, api: provider.api, baseUrl: provider.baseUrl, provider: providerId };
  const result = await provider.streamSimple(model, {
    messages: [{ role: "user", content: "test", timestamp: 0 }],
  }).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /429 Quota not available/);
  assert.equal(requests.length, 2, "preserve multi-region then regional inference fallback");
  assert.equal(metadata.id, baseModel.id);
});

test("bad cache is ignored and malformed/empty/HTTP catalog failures do not persist", async (t) => {
  const provider = setup(t);
  const models = await provider.refreshModels(refreshContext({ stored: { models: [{}], etag: "pi-anthropic-v1" } }));
  assert.deepEqual(models, provider.models);
  for (const payload of [{}, [], { broken: {} }, [{ ...baseModel, inputLimits: { images: { resize: { maxWidth: -1 } } } }]]) {
    const fetch = mockCatalog(t, payload);
    const context = refreshContext({ allowNetwork: true });
    await assert.rejects(provider.refreshModels(context), /empty or malformed|malformed model/);
    assert.deepEqual(context.publications, []);
    fetch.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(provider.refreshModels(refreshContext({ allowNetwork: true })), /503/);
});

test("cancellation or a rejected publication cannot persist a new catalog", async (t) => {
  const provider = setup(t);
  const controller = new AbortController();
  controller.abort();
  const fetch = mockCatalog(t);
  const context = refreshContext({ allowNetwork: true, signal: controller.signal });
  assert.deepEqual(await provider.refreshModels(context), provider.models);
  assert.equal(fetch.mock.callCount(), 0);
  const stale = refreshContext({ allowNetwork: true, publish: async () => false });
  assert.deepEqual(await provider.refreshModels(stale), provider.models);
});

test("real Pi runtime refreshes, restores offline and retains cache on failure", async (t) => {
  const provider = setup(t);
  const store = new InMemoryModelsStore();
  const runtime = await runtimeFor(provider, store);
  const fetch = mockCatalog(t);
  let result = await refresh(runtime, { allowNetwork: true, force: true });
  assert.equal(result.errors.size, 0);
  assert.equal(result.aborted, false);
  assert.equal(runtime.getModel(providerId, baseModel.id).cost.input, 4.4);
  assert.equal((await store.read(providerId)).models[0].cost.input, 4);
  assert.ok((await runtime.getAvailable(providerId)).some((m) => m.id === baseModel.id));
  fetch.mock.restore();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  result = await refresh(runtime, { allowNetwork: true, force: true });
  assert.match(result.errors.get(providerId).message, /offline/);
  assert.equal(runtime.getModel(providerId, baseModel.id).cost.input, 4.4);
  const restarted = await runtimeFor(provider, store);
  result = await refresh(restarted, { allowNetwork: false });
  assert.equal(result.errors.size, 0);
  assert.equal(restarted.getModel(providerId, baseModel.id).cost.input, 4.4);
});

test("real Pi runtime rejects a superseded refresh even when fetch ignores abort", async (t) => {
  const provider = setup(t);
  const store = new InMemoryModelsStore();
  const runtime = await runtimeFor(provider, store);
  let resolveOld, started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) {
      started();
      return new Promise((resolve) => { resolveOld = resolve; });
    }
    return Response.json([{ ...baseModel, name: "new catalog" }]);
  });
  const old = refresh(runtime, { allowNetwork: true, force: true });
  await firstStarted;
  const current = await refresh(runtime, { allowNetwork: true, force: true });
  assert.equal(current.errors.size, 0);
  resolveOld(Response.json([{ ...baseModel, name: "stale catalog" }]));
  await old;
  assert.equal(runtime.getModel(providerId, baseModel.id).name, "new catalog");
  assert.equal((await store.read(providerId)).models[0].name, "new catalog");
});
