# vertex-anthropic-pi

Pi extension package to use Anthropic partner models (Claude) through Google Vertex AI.

## What this provides

Registers a custom provider in pi:

- `vertex-anthropic`

Default models exposed:

- `claude-opus-4-7`
- `claude-opus-4-7[1m]`
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5@20251001`

## Requirements

- `gcloud` CLI installed and available in `PATH`
- Application Default Credentials configured:

```bash
gcloud auth application-default login
```

## Environment configuration

Set your Vertex project:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
# or
export ANTHROPIC_VERTEX_PROJECT_ID="your-project-id"
```

Set your regional endpoint location (used for existing regional endpoint + fallback):

```bash
export GOOGLE_CLOUD_LOCATION="europe-west1"
# optional alias:
# export VERTEX_ANTHROPIC_REGIONAL_LOCATION="europe-west1"
```

### Multi-region endpoint (EU REP example)

```bash
export ANTHROPIC_VERTEX_BASE_URL="https://aiplatform.eu.rep.googleapis.com/v1"
export CLOUD_ML_REGION="eu"
# optional alias for location if CLOUD_ML_REGION is not set:
# export VERTEX_ANTHROPIC_MULTI_LOCATION="eu"
```

With this config, models can be routed to multi-region and fall back to regional when needed.

## Install

### From local path

```bash
pi install /Users/A19D46E/workspace/lpoorth/vertex-anthropic-pi
```

### From git (recommended for team distribution)

```bash
pi install git:github.com/<your-org>/vertex-anthropic-pi@v0.1.0
```

## Usage

```bash
pi --provider vertex-anthropic --model claude-opus-4-7
```

Use 1M context Opus model:

```bash
pi --provider vertex-anthropic --model "claude-opus-4-7[1m]"
```

List provider models:

```bash
pi --list-models | rg vertex-anthropic
```

## Optional configuration

Override default model list:

```bash
export VERTEX_ANTHROPIC_MODELS="claude-opus-4-7,claude-opus-4-7[1m],claude-opus-4-6,claude-sonnet-4-6,claude-haiku-4-5@20251001"
```

If `VERTEX_ANTHROPIC_MODELS` is not set, the extension also reads Claude-style default model env vars when present:

```bash
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-7[1m]"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-6"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5@20251001"
export ANTHROPIC_SMALL_FAST_MODEL="claude-haiku-4-5@20251001"
```

Override per-model endpoint routing:

```bash
# Format: model=endpoints (pipe-separated order)
# Endpoints: regional | multi
export VERTEX_ANTHROPIC_MODEL_ENDPOINTS="claude-opus-4-7[1m]=multi|regional;claude-sonnet-4-6=regional"
```

Override per-model context window / max tokens:

```bash
# Format: model=contextWindow:maxTokens
export VERTEX_ANTHROPIC_MODEL_LIMITS="claude-opus-4-7[1m]=1000000:64000;claude-sonnet-4-6=200000:64000"
```

JSON format is also supported for both overrides.

Token override (if needed):

```bash
export GOOGLE_OAUTH_ACCESS_TOKEN="..."
# or
export VERTEX_ACCESS_TOKEN="..."
```

## Defaults for routing and limits

- `claude-opus-4-7[1m]`: `multi` then `regional`, context window `1,000,000`
- other default models: `regional` then `multi`, context window `200,000`
- default `maxTokens`: `64,000` per model

## Versioning and updates

- Use semantic versions and git tags (`v0.1.0`, `v0.2.0`, ...).
- Recommend teammates install pinned tags.
- Update with:

```bash
pi update
```
