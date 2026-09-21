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
