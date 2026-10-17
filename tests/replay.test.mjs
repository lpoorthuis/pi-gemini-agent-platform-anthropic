import assert from "node:assert/strict";
import { test } from "node:test";
import { load, modelFor, providerId, requestAuth, sse } from "./helpers.mjs";

const nativeApi = "anthropic-messages";
const legacyApi = "agent-platform-anthropic-api";
const modelId = "claude-opus-5-5";
const code = 'text(await tools.bash({command: "pwd"}));';
const initialMessages = () => [
  {
    role: "system", content: "Use codemode to batch tool calls.", timestamp: 0,
    toolsAdded: [{
      name: "codemode", description: "Run JavaScript.",
      parameters: {
        type: "object", properties: { code: { type: "string" } }, required: ["code"],
      },
    }],
  },
  { role: "user", content: "Check the repository.", timestamp: 1 },
];

function thinkingToolStream(turn) {
  return sse(
    { type: "message_start", message: { id: `msg_${turn}`, type: "message", role: "assistant", model: modelId, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspect the repository." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `signed_${turn}` } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: `toolu_${turn}`, name: "codemode", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ code }) } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  );
}

const toolResult = (assistant) => ({
  role: "toolResult", toolName: "codemode",
  toolCallId: assistant.content.find((block) => block.type === "toolCall").id,
  content: [{ type: "text", text: "Script completed" }], isError: false, timestamp: 2,
});

function capture(t) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return thinkingToolStream(requests.length);
  });
  return requests;
}

function wireOrder(request) {
  return request.messages.map((message) => message.output_config
    ? `effort:${message.output_config.effort}`
    : message.role);
}

test("managed thinking replays historical effort before each assistant across tool turns", async (t) => {
  const { provider } = load();
  const model = modelFor(provider, modelId);
  const requests = capture(t);
  const messages = initialMessages();
  const hookModels = [];
  const send = async (reasoning) => {
    const stream = provider.streamSimple(model, { messages }, {
      apiKey: requestAuth(), reasoning, maxRetries: 0,
      onPayload: (_payload, model) => { hookModels.push(model); },
      onResponse: (_response, model) => { hookModels.push(model); },
    });
    for await (const event of stream) {
      const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
      assert.equal(message.provider, providerId);
      assert.equal(message.api, model.api);
    }
    const result = await stream.result();
    assert.equal(result.stopReason, "toolUse", result.errorMessage);
    assert.deepEqual(result.content.find((block) => block.type === "toolCall").arguments, { code });
    return result;
  };

  const first = await send("low");
  assert.equal(first.providerThinkingLevel, "low");
  messages.push(first, toolResult(first));
  const second = await send("high");
  assert.equal(second.providerThinkingLevel, "high");
  messages.push(second, toolResult(second));
  await send("medium");

  assert.deepEqual(wireOrder(requests[0]), ["user", "effort:low"]);
  assert.deepEqual(wireOrder(requests[1]), ["user", "effort:low", "assistant", "user", "effort:high"]);
  assert.deepEqual(wireOrder(requests[2]), ["user", "effort:low", "assistant", "user", "effort:high", "assistant", "user", "effort:medium"]);
  assert.deepEqual(
    requests[2].messages.filter((message) => message.role === "assistant").map((message) => message.content[0]),
    [
      { type: "thinking", thinking: "Inspect the repository.", signature: "signed_1" },
      { type: "thinking", thinking: "Inspect the repository.", signature: "signed_2" },
    ],
  );
  assert.equal(model.api, nativeApi);
  assert.ok(hookModels.length > 0);
  assert.ok(hookModels.every((model) => model.provider === providerId && model.api === nativeApi));
});

test("resumed legacy messages retain effort and signed/redacted thinking without mutating history", async (t) => {
  const { provider } = load();
  const model = modelFor(provider, modelId);
  const requests = capture(t);
  const first = await provider.streamSimple(model, { messages: initialMessages() }, {
    apiKey: requestAuth(), reasoning: "low", maxRetries: 0,
  }).result();
  const legacy = {
    ...first, api: legacyApi,
    content: [first.content[0], { type: "thinking", thinking: "", thinkingSignature: "opaque_redacted", redacted: true }, ...first.content.slice(1)],
  };
  const messages = [...initialMessages(), legacy, toolResult(legacy)];
  const before = structuredClone(messages);
  const result = await provider.streamSimple(model, { messages }, {
    apiKey: requestAuth(), reasoning: "high", maxRetries: 0,
  }).result();

  assert.equal(result.stopReason, "toolUse", result.errorMessage);
  assert.deepEqual(wireOrder(requests[1]), ["user", "effort:low", "assistant", "user", "effort:high"]);
  assert.equal(result.api, nativeApi);
  const replay = requests[1].messages.find((message) => message.role === "assistant");
  assert.deepEqual(replay.content[0], { type: "thinking", thinking: "Inspect the repository.", signature: "signed_1" });
  assert.deepEqual(replay.content[1], { type: "redacted_thinking", data: "opaque_redacted" });
  assert.deepEqual(messages, before);
});

test("legacy migration does not replay another provider's thinking signatures or effort", async (t) => {
  const { provider } = load();
  const model = modelFor(provider, modelId);
  const requests = capture(t);
  const first = await provider.streamSimple(model, { messages: initialMessages() }, {
    apiKey: requestAuth(), reasoning: "low", maxRetries: 0,
  }).result();
  const foreign = {
    ...first, provider: "another-provider", api: legacyApi,
    content: [first.content[0], { type: "thinking", thinking: "", thinkingSignature: "foreign_redacted", redacted: true }, ...first.content.slice(1)],
  };
  await provider.streamSimple(model, { messages: [...initialMessages(), foreign, toolResult(foreign)] }, {
    apiKey: requestAuth(), reasoning: "high", maxRetries: 0,
  }).result();

  assert.deepEqual(wireOrder(requests[1]), ["user", "assistant", "user", "effort:high"]);
  const replay = requests[1].messages.find((message) => message.role === "assistant");
  assert.deepEqual(replay.content.find((block) => block.type === "tool_use").input, { code });
  assert.ok(replay.content.every((block) => !["thinking", "redacted_thinking"].includes(block.type)));
});
