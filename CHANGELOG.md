# Changelog

## Unreleased

- Removed the default `claude-opus-4-7[1m]` alias model
- Updated `claude-opus-4-6` max output tokens to `128,000`
- Updated `claude-haiku-4-5@20251001` context window to `200,000` input tokens
- Changed all default model routing to prefer multi-region before regional fallback
- Added regional fallback for multi-region quota exhaustion (`429`) responses
- Switched `claude-opus-4-7` reasoning requests to Agent Platform adaptive thinking format

## 0.4.0

- Rebranded the extension for Google Gemini Enterprise Agent Platform
- Added provider name `agent-platform-anthropic`
- Added Agent Platform env var aliases (`AGENT_PLATFORM_*`, `ANTHROPIC_AGENT_PLATFORM_*`) while retaining legacy Vertex env vars
- Updated docs to clarify Claude partner models still use the Agent Platform API host `aiplatform.googleapis.com` and `:streamRawPredict`
- Restored current documented Claude thinking request format (`thinking.type: enabled` with `budget_tokens`)
- Added dual endpoint routing support (multi-region + regional fallback) per model
- Added support for `ANTHROPIC_VERTEX_BASE_URL` (e.g. EU REP endpoint) with `CLOUD_ML_REGION`
- Added per-model endpoint override via `VERTEX_ANTHROPIC_MODEL_ENDPOINTS`
- Added per-model context window / max token defaults and overrides via `VERTEX_ANTHROPIC_MODEL_LIMITS`
- Added support for Claude-style default model env vars (`ANTHROPIC_DEFAULT_*`)
- Changed default routing for `claude-opus-4-7` to prefer multi-region with regional fallback
- Improved endpoint fallback errors to include all attempted endpoints
- Updated thinking request format to current documented Claude `thinking.type: enabled` + `budget_tokens` format
- Added multi-region env compatibility (`VERTEX_ANTHROPIC_BASE_URL`, `ANTHROPIC_VERTEX_LOCATION`) and automatic multi-region inference from base URL / `GOOGLE_CLOUD_LOCATION`
- Updated `claude-opus-4-7` default to 1M context and 128k max output tokens

## 0.2.0

- Added `claude-opus-4-7` to default models

## 0.1.0

- Initial release
- Added `vertex-anthropic` custom provider for pi
- Supports Anthropic partner models on Google Vertex AI via ADC
- Includes default models: Opus 4.6, Sonnet 4.6, Haiku 4.5
