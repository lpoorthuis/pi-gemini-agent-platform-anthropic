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

Default models exposed:

- `claude-opus-4.8`
- `claude-opus-4.7`
- `claude-opus-4.6`
- `claude-sonnet-5`
- `claude-sonnet-4.6`
- `claude-haiku-4.5@20251001`

## Quick start

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="your-project-id"
pi install .
pi --provider agent-platform-anthropic --model claude-sonnet-4.6
```

## Requirements

- Agent Platform API (`aiplatform.googleapis.com`) enabled in your Google Cloud project
- Claude partner models enabled from their Agent Platform / Model Garden model cards
- `gcloud` CLI installed and available in `PATH`
- Application Default Credentials configured with `gcloud auth application-default login`

## Environment configuration

Each knob has exactly one environment-variable name. There are no aliases.

| Variable | Purpose | Default |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | Google Cloud project ID (**required**) | — |
| `GOOGLE_CLOUD_LOCATION` | Regional fallback location | `europe-west1` |
| `AGENT_PLATFORM_ANTHROPIC_MULTI_LOCATION` | Multi-region location (`eu`, `us`, or `global`) | `eu` (or inferred from `GOOGLE_CLOUD_LOCATION`) |
| `AGENT_PLATFORM_ANTHROPIC_BASE_URL` | Multi-region base URL override | inferred from multi-region location |
| `GOOGLE_OAUTH_ACCESS_TOKEN` | Pre-fetched OAuth access token (skips `gcloud`) | obtained via ADC |
| `AGENT_PLATFORM_ANTHROPIC_MODELS` | Comma-separated model list override | built-in defaults |
| `AGENT_PLATFORM_ANTHROPIC_MODEL_ENDPOINTS` | Per-model endpoint routing override | multi → regional |
| `AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS` | Per-model `contextWindow:maxTokens` override | built-in defaults |
| `AGENT_PLATFORM_ANTHROPIC_ADAPTIVE_MODELS` | Models that use Agent Platform adaptive thinking | `claude-opus-4.8,claude-opus-4.7` |
| `AGENT_PLATFORM_ANTHROPIC_DEBUG` | Set to `1` to log SSE parse failures | off |

Supported multi-region locations:

- `eu` → `https://aiplatform.eu.rep.googleapis.com/v1`
- `us` → `https://aiplatform.us.rep.googleapis.com/v1`
- `global` → `https://aiplatform.googleapis.com/v1`

Notes:

- If no multi-region env vars are set, the extension defaults to `eu`.
- If only `GOOGLE_CLOUD_LOCATION` is set, the multi-region location is inferred (`europe-*` → `eu`, `us-*` → `us`).
- Model routing is multi-region first, regional fallback second unless overridden.

The extension also reads the standard Claude-Code model hints when `AGENT_PLATFORM_ANTHROPIC_MODELS` is not set: `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`.

## Usage

```bash
pi --provider agent-platform-anthropic --model claude-opus-4.8
```

List provider models:

```bash
pi --list-models | grep 'agent-platform-anthropic'
```

## Override formats

The per-model override variables accept either a JSON object or a delimited shorthand.

**Model list** (comma-separated):

```bash
export AGENT_PLATFORM_ANTHROPIC_MODELS="claude-opus-4.8,claude-sonnet-4.6"
```

**Endpoint routing** (`model=endpoints`, pipe-separated; endpoints are `regional` or `multi`):

```bash
export AGENT_PLATFORM_ANTHROPIC_MODEL_ENDPOINTS="claude-opus-4.8=multi;claude-sonnet-4.6=multi|regional"
# or JSON:
export AGENT_PLATFORM_ANTHROPIC_MODEL_ENDPOINTS='{"claude-opus-4.8":["multi"]}'
```

**Context window / max tokens** (`model=contextWindow:maxTokens`):

```bash
export AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS="claude-opus-4.8=1000000:128000"
# or JSON:
export AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS='{"claude-opus-4.8":{"contextWindow":1000000,"maxTokens":128000}}'
```

**Adaptive-thinking models** (comma-separated):

```bash
export AGENT_PLATFORM_ANTHROPIC_ADAPTIVE_MODELS="claude-opus-4.8,claude-opus-4.7"
```

## Defaults for routing, limits, and costs

The extension prefers the configured multi-region endpoint first, then falls back to the configured regional endpoint when the model is unavailable there or the multi-region endpoint returns quota exhaustion (`429`). The built-in costs below use the default EU multi-region / `europe-west1` pricing.

| Model | Routing order | Context window | Max output | Cost, USD / 1M tokens |
| --- | --- | ---: | ---: | --- |
| `claude-opus-4.8` | multi → regional | 1,000,000 | 128,000 | input 5.5, output 27.5, cache read 0.55, 5m cache write 6.875 |
| `claude-opus-4.7` | multi → regional | 1,000,000 | 128,000 | input 5.5, output 27.5, cache read 0.55, 5m cache write 6.875 |
| `claude-opus-4.6` | multi → regional | 1,000,000 | 128,000 | input 5.5, output 27.5, cache read 0.55, 5m cache write 6.875 |
| `claude-sonnet-4.6` | multi → regional | 1,000,000 | 128,000 | input 3.3, output 16.5, cache read 0.33, 5m cache write 4.13 |
| `claude-haiku-4.5@20251001` | multi → regional | 200,000 | 64,000 | input 1.1, output 5.5, cache read 0.11, 5m cache write 1.375 |

Unknown custom models default to a conservative 200,000-token context window and 64,000 max output tokens unless overridden with `AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS`.

For reasoning, `claude-opus-4.8` and `claude-opus-4.7` use the current Agent Platform adaptive thinking format (`thinking.type: adaptive` plus `output_config.effort`). Their pi `xhigh` level maps to Agent Platform effort `max`; `minimal` and `low` map to `low`. Other Claude models use Anthropic `thinking.type: enabled` with `budget_tokens`.

## Versioning and updates

- Use semantic versions and git tags (`v0.1.0`, `v0.2.0`, ...).
- Recommend teammates install pinned tags.
- Update with:

```bash
pi update
```
