# pi-gemini-agent-platform-anthropic

> [!NOTE]
> This custom provider only enables access to Anthropic partner models on Gemini Agent Platform

Pi extension that runs pi's Anthropic Claude models through Google Gemini Enterprise Agent Platform, authenticated with a service account key.

## Quick start

```bash
pi install .
pi
/login gemini-agent-platform-anthropic  # enter the service account JSON key path, pick eu / us / global
/model                                 # pick a gemini-agent-platform-anthropic model
```

No environment variables, `gcloud`, or Application Default Credentials are needed.

## How it works

- **Models** come from pi's own Anthropic catalog: the bundled list at startup, then pi's refreshed list once a session starts. Names, limits, thinking levels, and compat flags are pi's. A model pi knows about that isn't enabled for your project fails at request time with Google's 404.
- **Requests** use pi's built-in Anthropic Messages implementation (message conversion, tools, thinking, prompt caching, streaming, retries). The extension only reroutes the HTTP call to Agent Platform:
  - the model moves into the URL; dated IDs use the publisher form (`claude-haiku-4-5-20251001` → `claude-haiku-4-5@20251001`)
  - `anthropic_version: vertex-2023-10-16` goes in the body (a fixed value Google still requires despite the rename)
  - the `x-api-key` header is replaced with a Google OAuth bearer token
  - stable request fields precede the growing message history on the wire, avoiding Google prefix-cache misses observed with `messages` serialized first
  - models and new assistant messages use the native `anthropic-messages` API identity so pi replays historical thinking effort correctly. Earlier sessions and cached catalogs using `agent-platform-anthropic-api` remain readable; transcripts are not rewritten.
- **Auth**: `/login` reads the service account key, signs a JWT (RFC 7523, `cloud-platform` scope), and exchanges it at `https://oauth2.googleapis.com/token` for a one-hour access token. Pi stores the token, its expiry, the key **path**, the key's `project_id`, and the chosen location in `~/.pi/agent/auth.json`. The private key is never copied; pi re-reads it from disk to refresh the token before it expires.

## Endpoints

| Location | Tried in order | Cost estimate |
| --- | --- | --- |
| `eu` | `aiplatform.eu.rep.googleapis.com` → `europe-west1-aiplatform.googleapis.com` | pi price × 1.10 |
| `us` | `aiplatform.us.rep.googleapis.com` → `us-east5-aiplatform.googleapis.com` | pi price × 1.10 |
| `global` | `aiplatform.googleapis.com` | pi price |

The regional endpoint is tried when the multi-region endpoint returns 404 (model not offered there) or 429 (quota). To change location, run `/login` again.

## Requirements

- Pi 0.87.0 or newer
- A Google service account key whose project has the Agent Platform API and Anthropic partner models enabled, and a service account with `roles/aiplatform.user`
- Keep the key file private (`chmod 600`). `/logout` removes the stored credential.

## Development

```bash
npm install
npm test            # offline: mocked token endpoint and Agent Platform responses
npm run typecheck
npm run lint
npm run format:check
```
