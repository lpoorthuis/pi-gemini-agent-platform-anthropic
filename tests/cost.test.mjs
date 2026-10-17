import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateCost } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { load, providerId } from "./helpers.mjs";

function usage(overrides = {}) {
  return {
    input: 1000, output: 100, cacheRead: 8000, cacheWrite: 1000,
    totalTokens: 10100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const pricingFixture = (id, base) => ({
  ...getBuiltinModels("anthropic")[0], id, provider: providerId,
  cost: { input: base, output: base * 5, cacheRead: base * 0.05, cacheWrite: base * 1.25 },
});

// Google pricing, checked 2026-10-16: per 1M tokens, online (not batch).
// EU/US Sonnet 5.5: input 2.20, output 11, 5m write 2.75, 1h write 4.40, read 0.11.
// EU/US Opus 5.5: input 4.40, output 22, 5m write 5.50, 1h write 8.80, read 0.22.
for (const [id, base] of [["claude-sonnet-5-5", 2], ["claude-opus-5-5", 4]]) {
  for (const location of ["global", "eu", "us"]) {
    test(`${id}/${location}: uncached, cache-read, and short/long write costs stay separate`, () => {
      const { provider } = load();
      const source = pricingFixture(id, base);
      const [model] = provider.oauth.modifyModels([source], { location });
      const inputRate = base * (location === "global" ? 1 : 1.1);
      close(model.cost.input, inputRate);
      close(model.cost.output, inputRate * 5);
      close(model.cost.cacheRead, inputRate * 0.05);
      close(model.cost.cacheWrite, inputRate * 1.25);

      const short = usage();
      calculateCost(model, short);
      close(short.cost.input, 1000 * inputRate / 1e6);
      close(short.cost.output, 100 * inputRate * 5 / 1e6);
      close(short.cost.cacheRead, 8000 * inputRate * 0.05 / 1e6);
      close(short.cost.cacheWrite, 1000 * inputRate * 1.25 / 1e6);
      close(short.cost.total, (1000 + 100 * 5 + 8000 * 0.05 + 1000 * 1.25) * inputRate / 1e6);

      const mixed = usage({ cacheWrite1h: 250 });
      calculateCost(model, mixed);
      close(mixed.cost.cacheWrite, (750 * inputRate * 1.25 + 250 * inputRate * 2) / 1e6);
      close(mixed.cost.input, short.cost.input);
      close(mixed.cost.cacheRead, short.cost.cacheRead);

      const long = usage({ cacheWrite1h: 1000 });
      calculateCost(model, long);
      close(long.cost.cacheWrite, 1000 * inputRate * 2 / 1e6);
    });
  }
}

test("Sonnet 5.5 EU: rewriting a 10k-token prefix costs 25 times a cache read", () => {
  const { provider } = load();
  const source = pricingFixture("claude-sonnet-5-5", 2);
  const [model] = provider.oauth.modifyModels([source], { location: "eu" });
  const hit = usage({ input: 0, output: 0, cacheRead: 10000, cacheWrite: 0, totalTokens: 10000 });
  const miss = usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 10000, totalTokens: 10000 });
  calculateCost(model, hit);
  calculateCost(model, miss);
  close(hit.cost.total, 0.0011);
  close(miss.cost.total, 0.0275);
  close(miss.cost.total / hit.cost.total, 25);
});
