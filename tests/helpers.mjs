import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../extensions/agent-platform-anthropic.ts";

export const providerId = "agent-platform-anthropic";

/**
 * Loads the extension against a minimal fake ExtensionAPI. `fireSessionStart(models)` simulates
 * pi's session_start with a registry whose live Anthropic catalog is `models`.
 */
export function load() {
  const registrations = [];
  const handlers = {};
  register({
    on(event, handler) { handlers[event] = handler; },
    registerProvider(id, config) { assert.equal(id, providerId); registrations.push(config); },
  });
  const fireSessionStart = (models = [], reason = "startup") =>
    handlers.session_start({ type: "session_start", reason }, {
      modelRegistry: { getProvider: (id) => (id === "anthropic" ? { getModels: () => models } : undefined) },
    });
  return { provider: registrations[0], registrations, fireSessionStart };
}

export function writeKey(t, overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), "sa-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "key.json");
  writeFileSync(path, JSON.stringify({
    type: "service_account",
    project_id: "sa-project",
    client_email: "sa@sa-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    private_key_id: "kid-1",
    token_uri: "https://oauth2.googleapis.com/token",
    ...overrides,
  }));
  return { path, publicKey };
}

export const requestAuth = (location = "eu") =>
  JSON.stringify({ projectId: "sa-project", location, accessToken: "ya29.token" });

export function sse(...events) {
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

export const okStream = () => sse(
  { type: "message_start", message: { id: "msg_vrtx_1", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
);

export const userTurn = { messages: [{ role: "user", content: "ping", timestamp: 0 }] };

export function modelFor(provider, id) {
  const model = provider.models.find((m) => m.id === id);
  assert.ok(model, id);
  return { ...model, api: provider.api, provider: providerId, baseUrl: provider.baseUrl };
}
