import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../extensions/agent-platform-anthropic.ts";

const tool = (name, description = name) => ({
  name,
  description,
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
});
const user = { role: "user", content: "List files", timestamp: 1 };

// Exercise the registered stream and capture the actual HTTP body, without ADC or network.
async function captureRequest(t, messages) {
  const env = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(AGENT_PLATFORM_ANTHROPIC_|ANTHROPIC_DEFAULT_|ANTHROPIC_SMALL_FAST_)/.test(key)) {
      delete process.env[key];
    }
  }
  process.env.GOOGLE_CLOUD_PROJECT = "test-project";
  process.env.GOOGLE_OAUTH_ACCESS_TOKEN = "offline-test-token";
  process.env.GOOGLE_CLOUD_LOCATION = "europe-west1";
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  });

  let provider;
  register({
    on() {},
    registerProvider(id, config) {
      assert.equal(id, "agent-platform-anthropic");
      provider = config;
    },
  });
  let body;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n' +
        'data: {"type":"message_stop"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const model = {
    ...provider.models.find((item) => item.id === "claude-opus-5"),
    api: provider.api,
    provider: "agent-platform-anthropic",
    baseUrl: provider.baseUrl,
  };
  const result = await provider.streamSimple(model, { messages }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.ok(body);
  return body;
}

test("forwards transcript-backed system sections and harness tools", async (t) => {
  const body = await captureRequest(t, [
    {
      role: "system",
      content: "",
      sections: { preamble: "You are a coding assistant.", rules: "Use bash to list files." },
      toolsAdded: [tool("bash"), tool("read")],
      timestamp: 0,
    },
    user,
  ]);
  assert.match(body.system[0].text, /You are a coding assistant/);
  assert.match(body.system[0].text, /Use bash to list files/);
  assert.deepEqual(body.tools.map((item) => item.name), ["bash", "read"]);
  assert.deepEqual(body.tools[0].input_schema, tool("bash").parameters);
  assert.deepEqual(body.messages.map((item) => item.role), ["user"]);
  assert.equal(body.messages[0].content[0].text, "List files");
  assert.equal(body.system[0].cache_control.type, "ephemeral");
});

test("replays mid-conversation prompt patches and tool additions/removals/redefinitions", async (t) => {
  const body = await captureRequest(t, [
    {
      role: "system", content: "Base prompt", timestamp: 0,
      sections: { rules: "Old rules", obsolete: "Remove this section" },
      toolsAdded: [tool("bash"), tool("read")],
    },
    user,
    {
      role: "system", content: "Additional instructions", timestamp: 2,
      sections: { rules: "New rules", obsolete: null },
      toolsRemoved: [{ name: "read" }],
      toolsAdded: [tool("bash", "Updated shell tool"), tool("write")],
    },
    { ...user, timestamp: 3 },
  ]);
  const prompt = body.system[0].text;
  assert.match(prompt, /Base prompt/);
  assert.match(prompt, /Additional instructions/);
  assert.match(prompt, /New rules/);
  assert.doesNotMatch(prompt, /Old rules|Remove this section/);
  assert.deepEqual(body.tools.map((item) => item.name), ["bash", "write"]);
  assert.equal(body.tools[0].description, "Updated shell tool");
  assert.deepEqual(body.messages.map((item) => item.role), ["user", "user"]);
});

test("omits empty prompt and tools", async (t) => {
  const body = await captureRequest(t, [user]);
  assert.equal(body.system, undefined);
  assert.equal(body.tools, undefined);
  assert.equal(body.messages.length, 1);
});

test("does not forward tools removed later in the transcript", async (t) => {
  const body = await captureRequest(t, [
    { role: "system", content: "", toolsAdded: [tool("bash")], timestamp: 0 },
    user,
    { role: "system", content: "", toolsRemoved: [{ name: "bash" }], timestamp: 2 },
  ]);
  assert.equal(body.tools, undefined);
});

const openAiToolId =
  "call_n9nYAu2QnNT8QdsUjZafKEyF|p4RzRI/ROQeJ8UZ/cOypuag7DvQ3afvPax3rRhZEP2ofvPctlsmskHpxLeqFUdIja0QI4mfBfCazgtYaKhrHU3qDOCPtrXlChX5EkiRfjTdTb5gEC20f2cT5+WGU8f2AXr+Gz8ctX/OUyCQCCJpvOv415aEOkjlH4ko72d1hSe0Q=";
const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistantFrom = (provider, api, model, content) => ({
  role: "assistant", content, api, provider, model, usage, stopReason: "toolUse", timestamp: 2,
});
const toolResult = (toolCallId, text = "ok") => ({
  role: "toolResult", toolCallId, toolName: "bash",
  content: [{ type: "text", text }], isError: false, timestamp: 3,
});
const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

test("normalizes foreign tool call ids to Anthropic's pattern and keeps pairs matched", async (t) => {
  const body = await captureRequest(t, [
    user,
    assistantFrom("github-copilot", "openai-responses", "gpt-6-astra", [
      { type: "thinking", thinking: "", thinkingSignature: '{"encrypted_content":"abc"}' },
      { type: "thinking", thinking: "Plan the listing", thinkingSignature: '{"encrypted_content":"def"}' },
      { type: "toolCall", id: openAiToolId, name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: `${openAiToolId}+`, name: "bash", arguments: { command: "pwd" } },
    ]),
    toolResult(openAiToolId, "a"),
    toolResult(`${openAiToolId}+`, "b"),
    { ...user, content: "test", timestamp: 4 },
  ]);

  const [toolUseA, toolUseB] = body.messages[1].content.filter((b) => b.type === "tool_use");
  const results = body.messages[2].content;
  for (const id of [toolUseA.id, toolUseB.id]) assert.match(id, TOOL_ID_PATTERN);
  assert.notEqual(toolUseA.id, toolUseB.id, "colliding ids must stay distinct");
  assert.deepEqual(results.map((b) => b.tool_use_id), [toolUseA.id, toolUseB.id]);
  assert.deepEqual(results.map((b) => b.content), ["a", "b"]);

  // Foreign signed thinking must not be sent as Anthropic thinking blocks.
  assert.ok(!body.messages[1].content.some((b) => b.type === "thinking" || b.type === "redacted_thinking"));
  assert.ok(body.messages[1].content.some((b) => b.type === "text" && b.text === "Plan the listing"));
});

test("replays signed thinking and redacted thinking only for the same model", async (t) => {
  const body = await captureRequest(t, [
    user,
    assistantFrom("agent-platform-anthropic", "agent-platform-anthropic-api", "claude-opus-5", [
      { type: "thinking", thinking: "Same-model thought", thinkingSignature: "sig-1" },
      { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
      { type: "toolCall", id: "toolu_01ABC", name: "bash", arguments: { command: "ls" } },
    ]),
    toolResult("toolu_01ABC"),
    assistantFrom("agent-platform-anthropic", "agent-platform-anthropic-api", "claude-sonnet-5", [
      { type: "thinking", thinking: "Other-model thought", thinkingSignature: "sig-2" },
      { type: "thinking", thinking: "", thinkingSignature: "opaque-2", redacted: true },
      { type: "text", text: "done" },
    ]),
    { ...user, timestamp: 5 },
  ]);

  assert.deepEqual(body.messages[1].content.slice(0, 2), [
    { type: "thinking", thinking: "Same-model thought", signature: "sig-1" },
    { type: "redacted_thinking", data: "opaque" },
  ]);
  assert.equal(body.messages[1].content[2].id, "toolu_01ABC", "valid ids pass through unchanged");
  assert.equal(body.messages[2].content[0].tool_use_id, "toolu_01ABC");
  assert.deepEqual(body.messages[3].content, [
    { type: "text", text: "Other-model thought" },
    { type: "text", text: "done" },
  ]);
});
