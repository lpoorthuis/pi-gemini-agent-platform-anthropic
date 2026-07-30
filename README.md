# agent-platform-anthropic-pi

Pi extension package to use Anthropic Claude partner models through Google Gemini Enterprise Agent Platform.

Claude partner-model prediction requests are sent to the Agent Platform API host `aiplatform.googleapis.com` using the publisher-model streaming endpoint:

```text
POST https://LOCATION-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/LOCATION/publishers/anthropic/models/MODEL:streamRawPredict
```

Multi-region endpoints use the REP hosts, for example:

```text
POST https://aiplatform.eu.rep.googleapis.com/v1/projects/PROJECT_ID/locations/eu/publishers/anthropic/models/MODEL:streamRawPredict
```

## What this provides

Registers a custom provider in pi:

- `agent-platform-anthropic`

The provider dynamically projects every Claude model known by pi's Anthropic catalog into Google Agent Platform, inheriting pi's current model metadata. The Anthropic catalog bundled with the installed pi version provides the first-run/offline fallback.

## Quick start

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="your-project-id"
pi install .
pi --provider agent-platform-anthropic --model claude-sonnet-4.6
```

## Requirements

- Pi and `@earendil-works/pi-ai` version **0.87.0 or newer** (transactional model refresh, transcript-backed prompts/tools, and model image limits)
- Agent Platform API (`aiplatform.googleapis.com`) enabled in your Google Cloud project
- Anthropic partner-model access enabled for the Google Cloud project
- `gcloud` CLI installed and available in `PATH`
- Application Default Credentials configured with `gcloud auth application-default login`

## Dynamic model discovery

When pi refreshes this configured provider, the extension:

1. Restores cached base metadata from `~/.pi/agent/models-store.json` immediately.
2. Fetches pi's current Anthropic metadata catalog from `pi.dev`.
3. Projects every pi-known Anthropic model into the Google provider, inheriting names, modalities, input/image limits, reasoning support, thinking-level maps, adaptive-thinking behavior, and base cost estimates.
4. Reprices those base estimates for the configured Agent Platform multi-region and caches the unscaled source metadata for future offline use.

Opening `/model` triggers pi's ordinary background provider refresh. The extension throttles successful network refreshes to once every four hours. Callers using pi's model-runtime API can set `force: true` to bypass that throttle; `/model` itself does not force a refresh. On a network, empty, or malformed response, pi reports the refresh error while retaining the current model snapshot and performing its cache-only fallback; aborted refreshes also keep the cache or bundled fallback.

Catalog refresh does **not** call Google, inspect Model Garden entitlements, require ADC, or probe paid inference. The provider assumes every Anthropic model known by pi is enabled in your Google Agent Platform project. Models are not hidden because of unavailable quota or access. The inference request is authoritative: users manage model enablement, quota, and availability failures themselves. A newly released model can appear before Google finishes rolling it out.

`GOOGLE_CLOUD_PROJECT` and ADC remain required when a model is actually invoked, not when the model catalog refreshes.

## Environment configuration

Each knob has exactly one environment-variable name. There are no aliases.

| Variable | Purpose | Default |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | Google Cloud project ID (**required for inference**) | — |
| `GOOGLE_CLOUD_LOCATION` | Regional fallback location | `europe-west1` |
| `AGENT_PLATFORM_ANTHROPIC_MULTI_LOCATION` | Multi-region location (`eu`, `us`, or `global`) | `eu` (or inferred from `GOOGLE_CLOUD_LOCATION`) |
| `AGENT_PLATFORM_ANTHROPIC_BASE_URL` | Multi-region base URL override | inferred from multi-region location |
| `GOOGLE_OAUTH_ACCESS_TOKEN` | Pre-fetched OAuth access token (skips `gcloud`) | obtained via ADC |
| `AGENT_PLATFORM_ANTHROPIC_MODELS` | Exact comma-separated model list override; still inherits matching pi metadata | all models in pi's Anthropic catalog |
| `AGENT_PLATFORM_ANTHROPIC_MODEL_ENDPOINTS` | Per-model endpoint routing override | multi-region first, then regional fallback |
| `AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS` | Per-model `contextWindow:maxTokens` override | inherited from pi metadata |
| `AGENT_PLATFORM_ANTHROPIC_ADAPTIVE_MODELS` | Explicit override for models that use Agent Platform adaptive thinking | inherited from pi metadata |
| `AGENT_PLATFORM_ANTHROPIC_DEBUG` | Set to `1` to log SSE parse failures and cache warnings | off |

Supported multi-region locations:

- `eu` → `https://aiplatform.eu.rep.googleapis.com/v1`
- `us` → `https://aiplatform.us.rep.googleapis.com/v1`
- `global` → `https://aiplatform.googleapis.com/v1`

Notes:

- If no multi-region env vars are set, the extension defaults to `eu`.
- Base prices come from pi's dynamically refreshed Anthropic catalog. Estimates are multiplied by `1.10` for `eu` and `us`; `global` uses `1.00`. Pricing tiers are scaled as well.
- Cached metadata stores unscaled base prices. Changing the configured multi-region therefore reprices the cache without requiring another network refresh.
- If only `GOOGLE_CLOUD_LOCATION` is set, the multi-region location is inferred (`europe-*` → `eu`, `us-*` → `us`).
- Most models try multi-region first, then regional fallback. `claude-opus-5`, `claude-sonnet-5`, and explicit `[1m]` aliases use only the multi-region endpoint.

The extension also reads the standard Claude-Code model hints when `AGENT_PLATFORM_ANTHROPIC_MODELS` is not set: `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`.

## Usage

```bash
pi --provider agent-platform-anthropic --model claude-opus-5
```

List provider models:

```bash
pi --list-models | grep 'agent-platform-anthropic'
```

## Override formats

The per-model override variables accept either a JSON object or a delimited shorthand.

**Model list** (comma-separated):

```bash
export AGENT_PLATFORM_ANTHROPIC_MODELS="claude-opus-5,claude-sonnet-4.6"
```

**Endpoint routing** (`model=endpoints`, pipe-separated; endpoints are `regional` or `multi`):

```bash
export AGENT_PLATFORM_ANTHROPIC_MODEL_ENDPOINTS="claude-opus-5=multi;claude-sonnet-4.6=multi|regional"
# or JSON:
export AGENT_PLATFORM_ANTHROPIC_MODEL_ENDPOINTS='{"claude-opus-5":["multi"]}'
```

**Context window / max tokens** (`model=contextWindow:maxTokens`):

```bash
export AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS="claude-opus-5=1000000:128000"
# or JSON:
export AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS='{"claude-opus-5":{"contextWindow":1000000,"maxTokens":128000}}'
```

**Adaptive-thinking models** (comma-separated):

```bash
export AGENT_PLATFORM_ANTHROPIC_ADAPTIVE_MODELS="claude-opus-5,claude-opus-4.8,claude-opus-4.7,claude-sonnet-5"
```

## Routing, limits, costs, and thinking

Models inherit limits, modalities, costs, and thinking capabilities from pi. Most models prefer the configured multi-region endpoint and fall back to the regional endpoint when the model is unavailable or the multi-region endpoint returns quota exhaustion (`429`). `claude-opus-5`, `claude-sonnet-5`, and explicit `[1m]` aliases use only the multi-region endpoint. Per-model endpoint and limit overrides remain authoritative.

Unknown IDs supplied through `AGENT_PLATFORM_ANTHROPIC_MODELS` use conservative defaults of a 200,000-token context window, 64,000 max output, text/image input, and zero cost until pi provides metadata for them. An unknown `[1m]` alias uses a 1,000,000-token context window.

Adaptive versus budget-based thinking is inherited per model from pi. The extension preserves pi's supported/unsupported thinking levels, clamps requests to a supported level, and maps that level through the inherited `thinkingLevelMap` before sending `output_config.effort`. Models that disallow thinking `off` therefore still receive adaptive thinking when callers omit a reasoning level. `AGENT_PLATFORM_ANTHROPIC_ADAPTIVE_MODELS` can explicitly override adaptive model detection for operator-managed aliases.

Image preprocessing limits are inherited from pi. Prompt-cache metadata advertises only the short lifetime (at most 300 seconds), matching this transport's five-minute ephemeral cache writes; Anthropic's one-hour cache and direct-API-only compatibility flags are not advertised. `cacheRetention: "none"` disables cache markers.

## Development tests

With Node.js 22.6+ and the peer dependencies installed (`npm install`), run `npm test`.
The tests capture outgoing requests with mocked HTTP responses; no Google credentials or live API calls are required.
They cover system-prompt sections, tool declarations, mid-conversation updates, empty/removed tools, catalog discovery and validation, offline caches, pricing, overrides, thinking requests, and quota errors. Integration tests use Pi's real `ModelRuntime` with in-memory stores to verify refresh publication, restart recovery, and cancellation/superseded refreshes.

Run `npm run typecheck`, `npm run lint`, and `npm run format:check` for static checks.

Compatibility review: Pi 0.84 replaced `context.store` with `context.stored` / `context.publish()`; 0.86 introduced `TranscriptContext` and cache-lifetime metadata; 0.87 added model image limits; 0.87.1 added Opus 5.5 metadata (including unsupported `off`/`minimal` thinking). These models and future catalog additions require no hardcoded model-list updates.

## Versioning and updates

- Use semantic versions and git tags (`v0.1.0`, `v0.2.0`, ...).
- Recommend teammates install pinned tags.
- Update with:

```bash
pi update
```
