# vertex-anthropic-pi

Pi extension package to use Anthropic partner models (Claude) through Google Gemini Enterprise Agent Platform.

Google has rebranded/moved the former Vertex AI generative AI docs and model surfaces into **Gemini Enterprise Agent Platform**. The Claude partner-model prediction API is still exposed through the Agent Platform API host `aiplatform.googleapis.com` and still uses the publisher model endpoint:

```text
POST https://LOCATION-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/LOCATION/publishers/anthropic/models/MODEL:streamRawPredict
```

## What this provides

Registers a custom provider in pi:

- `agent-platform-anthropic`

Default models exposed:

- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5@20251001`

## Requirements

- Agent Platform API (`aiplatform.googleapis.com`) enabled in your Google Cloud project
- Claude partner models enabled from their Agent Platform / Model Garden model cards
- `gcloud` CLI installed and available in `PATH`
- Application Default Credentials configured:

```bash
gcloud auth application-default login
```

## Environment configuration

Set your Google Cloud project:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
# Agent Platform aliases:
export AGENT_PLATFORM_PROJECT_ID="your-project-id"
export ANTHROPIC_AGENT_PLATFORM_PROJECT_ID="your-project-id"
# legacy alias still supported:
export ANTHROPIC_VERTEX_PROJECT_ID="your-project-id"
```

Set your regional endpoint location:

```bash
export GOOGLE_AGENT_PLATFORM_LOCATION="europe-west1"
# or legacy:
export GOOGLE_CLOUD_LOCATION="europe-west1"
```

### Multi-region / global endpoint

```bash
export ANTHROPIC_AGENT_PLATFORM_BASE_URL="https://aiplatform.eu.rep.googleapis.com/v1"
export AGENT_PLATFORM_ANTHROPIC_MULTI_LOCATION="eu"
```

Legacy Vertex-style env vars remain supported:

```bash
export ANTHROPIC_VERTEX_BASE_URL="https://aiplatform.eu.rep.googleapis.com/v1"
export CLOUD_ML_REGION="eu"
```

Notes:

- If no explicit multi-region env vars are set, the extension can infer `eu` / `us` from a regional location such as `europe-west1` or `us-central1`, otherwise it defaults multi-region routing to `global`.
- `global` uses `https://aiplatform.googleapis.com/v1`.
- `eu` / `us` use `https://aiplatform.eu.rep.googleapis.com/v1` or `https://aiplatform.us.rep.googleapis.com/v1`.

## Install

```bash
pi install ./vertex-anthropic-pi
# or install from a pinned git tag:
pi install https://github.com/your-org/vertex-anthropic-pi.git#v0.4.0
```

## Usage

```bash
pi --provider agent-platform-anthropic --model claude-opus-4-7
```

List provider models:

```bash
pi --list-models | rg 'agent-platform-anthropic'
```

## Optional configuration

Override default model list:

```bash
export AGENT_PLATFORM_ANTHROPIC_MODELS="claude-opus-4-7,claude-opus-4-6,claude-sonnet-4-6,claude-haiku-4-5@20251001"
# legacy name also supported:
export VERTEX_ANTHROPIC_MODELS="claude-opus-4-7,claude-opus-4-6,claude-sonnet-4-6,claude-haiku-4-5@20251001"
```

If no explicit model list is set, the extension also reads Claude-style defaults when present:

```bash
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-7"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-6"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5@20251001"
export ANTHROPIC_SMALL_FAST_MODEL="claude-haiku-4-5@20251001"
```

Override per-model endpoint routing:

```bash
# Format: model=endpoints (pipe-separated order)
# Endpoints: regional | multi
export AGENT_PLATFORM_ANTHROPIC_MODEL_ENDPOINTS="claude-opus-4-7=multi;claude-sonnet-4-6=multi|regional"
```

Override per-model context window / max tokens:

```bash
# Format: model=contextWindow:maxTokens
export AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS="claude-opus-4-7=1000000:128000;claude-sonnet-4-6=1000000:64000"
```

JSON format is also supported for both overrides. Legacy `VERTEX_ANTHROPIC_MODEL_ENDPOINTS` and `VERTEX_ANTHROPIC_MODEL_LIMITS` are still supported.

Token override (if needed):

```bash
export GOOGLE_OAUTH_ACCESS_TOKEN="..."
# Agent Platform alias:
export AGENT_PLATFORM_ACCESS_TOKEN="..."
# legacy alias:
export VERTEX_ACCESS_TOKEN="..."
```

## Defaults for routing and limits

The extension prefers multi-region endpoints first, then falls back to the configured regional endpoint when the model is unavailable there or the multi-region endpoint returns quota exhaustion (`429`).


- `claude-opus-4-7`: `multi` then `regional`, context window `1,000,000`, max output tokens `128,000`
- `claude-opus-4-6`: `multi` then `regional`, context window `1,000,000`, max output tokens `128,000`
- `claude-sonnet-4-6`: `multi` then `regional`, context window `1,000,000`, max output tokens `64,000`
- `claude-haiku-4-5@20251001`: `multi` then `regional`, context window `200,000`, max output tokens `64,000`

For reasoning, `claude-opus-4-7` uses the current Agent Platform adaptive thinking format (`thinking.type: adaptive` plus `output_config.effort`). Other Claude models use Anthropic `thinking.type: enabled` with `budget_tokens`.

## Versioning and updates

- Use semantic versions and git tags (`v0.1.0`, `v0.2.0`, ...).
- Recommend teammates install pinned tags.
- Update with:

```bash
pi update
```
