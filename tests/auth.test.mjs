import assert from "node:assert/strict";
import { createVerify } from "node:crypto";
import { homedir } from "node:os";
import { relative } from "node:path";
import { test } from "node:test";
import { load, writeKey } from "./helpers.mjs";

function mockTokenEndpoint(t, publicKey, token = "minted-token") {
  return t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = form.get("assertion").split(".");
    assert.ok(
      createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url")),
      "JWT must be signed with the service account key",
    );
    assert.equal(JSON.parse(Buffer.from(header, "base64url")).kid, "kid-1");
    const payload = JSON.parse(Buffer.from(claims, "base64url"));
    assert.equal(payload.iss, "sa@sa-project.iam.gserviceaccount.com");
    assert.equal(payload.aud, "https://oauth2.googleapis.com/token");
    assert.equal(payload.scope, "https://www.googleapis.com/auth/cloud-platform");
    return Response.json({ access_token: token, expires_in: 3599, token_type: "Bearer" });
  });
}

const callbacks = (path, location = "us") => ({
  onAuth() {}, onDeviceCode() {}, onProgress() {},
  onPrompt: async () => path,
  onSelect: async () => location,
});

test("login exchanges a service account key; project comes from the key, not env or ADC", async (t) => {
  const { provider } = load();
  const { path, publicKey } = writeKey(t);
  mockTokenEndpoint(t, publicKey);
  const credentials = await provider.oauth.login(callbacks(`  ${path}  `));
  assert.equal(credentials.refresh, path, "only the key path is persisted");
  assert.doesNotMatch(JSON.stringify(credentials), /PRIVATE KEY/);
  assert.equal(credentials.access, "minted-token");
  assert.equal(credentials.projectId, "sa-project");
  assert.equal(credentials.location, "us");
  assert.ok(credentials.expires > Date.now() + 3500_000);
  assert.deepEqual(JSON.parse(provider.oauth.getApiKey(credentials)), {
    projectId: "sa-project", location: "us", accessToken: "minted-token",
  });
});

for (const prefix of ["~", "$HOME", "${HOME}"]) {
  test(`login expands ${prefix} in service account key paths`, async (t) => {
    const { provider } = load();
    const { path, publicKey } = writeKey(t);
    mockTokenEndpoint(t, publicKey);
    const input = `  ${prefix}/${relative(homedir(), path)}  `;
    const credentials = await provider.oauth.login(callbacks(input));
    assert.equal(credentials.refresh, path, "the expanded absolute path is persisted for refresh");
    assert.equal(credentials.access, "minted-token");
  });
}

test("refresh re-reads the key file, mints a new token and keeps the location", async (t) => {
  const { provider } = load();
  const { path, publicKey } = writeKey(t);
  mockTokenEndpoint(t, publicKey, "rotated-token");
  const refreshed = await provider.oauth.refreshToken(
    { refresh: path, access: "old", expires: 0, projectId: "sa-project", location: "global" },
    new AbortController().signal,
  );
  assert.equal(refreshed.access, "rotated-token");
  assert.equal(refreshed.location, "global");
});

test("login rejects files that are not service account keys without contacting Google", async (t) => {
  const { provider } = load();
  const { path } = writeKey(t, { type: "authorized_user" });
  t.mock.method(globalThis, "fetch", () => assert.fail("must not contact Google"));
  await assert.rejects(provider.oauth.login(callbacks(path)), /not a Google service account key/);
  await assert.rejects(provider.oauth.login(callbacks("/does/not/exist.json")), /Could not read/);
});

test("token exchange errors surface Google's reason", async (t) => {
  const { provider } = load();
  const { path } = writeKey(t);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, { status: 400 }));
  await assert.rejects(provider.oauth.login(callbacks(path)), /Invalid JWT Signature/);
});
