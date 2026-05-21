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

- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5@20251001`

## Quick start

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="your-project-id"
pi install .
pi --provider agent-platform-anthropic --model claude-sonnet-4-6
```

## Requirements

- Agent Platform API (`aiplatform.googleapis.com`) enabled in your Google Cloud project
- Claude partner models enabled from their Agent Platform / Model Garden model cards
- `gcloud` CLI installed and available in `PATH`
- Application Default Credentials configured with `gcloud auth application-default login`

## Environment configuration

### Project

Set your Google Cloud project:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
```

Accepted project aliases:

```bash
export GOOGLE_AGENT_PLATFORM_PROJECT="your-project-id"
export AGENT_PLATFORM_PROJECT_ID="your-project-id"
export ANTHROPIC_AGENT_PLATFORM_PROJECT_ID="your-project-id"
```

### Regional fallback location

The default regional fallback is `europe-west1`.

```bash
export GOOGLE_AGENT_PLATFORM_LOCATION="europe-west1"
# or general Google Cloud alias:
export GOOGLE_CLOUD_LOCATION="europe-west1"
# or provider-specific alias:
export AGENT_PLATFORM_ANTHROPIC_REGIONAL_LOCATION="europe-west1"
```

### Multi-region endpoint

By default the extension prefers the EU multi-region endpoint (`eu`) and falls back to the configured regional endpoint.

```bash
export AGENT_PLATFORM_ANTHROPIC_MULTI_LOCATION="eu"
```

Supported multi-region locations:

- `eu` → `https://aiplatform.eu.rep.googleapis.com/v1`
- `us` → `https://aiplatform.us.rep.googleapis.com/v1`
- `global` → `https://aiplatform.googleapis.com/v1`

You can also set the multi-region base URL explicitly:

```bash
export ANTHROPIC_AGENT_PLATFORM_BASE_URL="https://aiplatform.eu.rep.googleapis.com/v1"
export AGENT_PLATFORM_ANTHROPIC_MULTI_LOCATION="eu"
```

Accepted multi-region aliases:

```bash
export AGENT_PLATFORM_ANTHROPIC_BASE_URL="https://aiplatform.eu.rep.googleapis.com/v1"
export ANTHROPIC_AGENT_PLATFORM_LOCATION="eu"
```

Notes:

- If no explicit multi-region env vars are set, the extension defaults to `eu`.
- If only a regional location is set, the extension can infer `eu` or `us` for multi-region routing from locations such as `europe-west1` or `us-central1`.
- Model routing is multi-region first, regional fallback second unless overridden.

## Usage

```bash
pi --provider agent-platform-anthropic --model claude-opus-4-7
```

List provider models:

```bash
pi --list-models | grep 'agent-platform-anthropic'
```

## Optional configuration

### Override default model list

```bash
export AGENT_PLATFORM_ANTHROPIC_MODELS="claude-opus-4-7,claude-opus-4-6,claude-sonnet-4-6,claude-haiku-4-5@20251001"
```

If no explicit model list is set, the extension also reads Claude-style defaults when present:

```bash
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-7"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-6"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5@20251001"
export ANTHROPIC_SMALL_FAST_MODEL="claude-haiku-4-5@20251001"
```

### Override per-model endpoint routing

```bash
# Format: model=endpoints (pipe-separated order)
# Endpoints: regional | multi
export AGENT_PLATFORM_ANTHROPIC_MODEL_ENDPOINTS="claude-opus-4-7=multi;claude-sonnet-4-6=multi|regional"
```

JSON format is also supported:

```bash
export AGENT_PLATFORM_ANTHROPIC_MODEL_ENDPOINTS='{"claude-opus-4-7":["multi"],"claude-sonnet-4-6":["multi","regional"]}'
```

### Override per-model context window / max tokens

```bash
# Format: model=contextWindow:maxTokens
export AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS="claude-opus-4-7=1000000:128000;claude-sonnet-4-6=1000000:128000"
```

JSON format is also supported:

```bash
export AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS='{"claude-opus-4-7":{"contextWindow":1000000,"maxTokens":128000}}'
```

### Configure adaptive-thinking models

`claude-opus-4-7` uses Agent Platform adaptive thinking by default. To add future snapshots before this package is updated:

```bash
export AGENT_PLATFORM_ANTHROPIC_ADAPTIVE_MODELS="claude-opus-4-7,claude-opus-4-8"
```

### Token override

Normally the extension retrieves an ADC access token from `gcloud` and caches it in memory for 55 minutes. If needed, provide a token directly:

```bash
export GOOGLE_OAUTH_ACCESS_TOKEN="..."
# or:
export AGENT_PLATFORM_ACCESS_TOKEN="..."
```

### Debug stream parsing

Enable debug warnings for malformed stream events:

```bash
export AGENT_PLATFORM_ANTHROPIC_DEBUG=1
```

## Defaults for routing, limits, and costs

The extension prefers the configured multi-region endpoint first, then falls back to the configured regional endpoint when the model is unavailable there or the multi-region endpoint returns quota exhaustion (`429`).

| Model | Routing order | Context window | Max output | Cost, USD / 1M tokens |
| --- | --- | ---: | ---: | --- |
| `claude-opus-4-7` | multi → regional | 1,000,000 | 128,000 | input 5, output 25, cache read 0.5, cache write 6.25 |
| `claude-opus-4-6` | multi → regional | 1,000,000 | 128,000 | input 5, output 25, cache read 0.5, cache write 6.25 |
| `claude-sonnet-4-6` | multi → regional | 1,000,000 | 128,000 | input 3, output 15, cache read 0.3, cache write 3.75 |
| `claude-haiku-4-5@20251001` | multi → regional | 200,000 | 64,000 | input 1, output 5, cache read 0.1, cache write 1.25 |

Unknown custom models default to a conservative 200,000-token context window and 64,000 max output tokens unless overridden with `AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS`.

For reasoning, `claude-opus-4-7` uses the current Agent Platform adaptive thinking format (`thinking.type: adaptive` plus `output_config.effort`). Its pi `xhigh` level maps to Agent Platform effort `max`; `minimal` and `low` map to `low`. Other Claude models use Anthropic `thinking.type: enabled` with `budget_tokens`.

## Versioning and updates

- Use semantic versions and git tags (`v0.1.0`, `v0.2.0`, ...).
- Recommend teammates install pinned tags.
- Update with:

```bash
pi update
```
