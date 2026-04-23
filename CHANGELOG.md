# Changelog

## Unreleased

- Added dual endpoint routing support (multi-region + regional fallback) per model
- Added support for `ANTHROPIC_VERTEX_BASE_URL` (e.g. EU REP endpoint) with `CLOUD_ML_REGION`
- Added per-model endpoint override via `VERTEX_ANTHROPIC_MODEL_ENDPOINTS`
- Added per-model context window / max token defaults and overrides via `VERTEX_ANTHROPIC_MODEL_LIMITS`
- Added support for Claude-style default model env vars (`ANTHROPIC_DEFAULT_*`)
- Added default model `claude-opus-4-7[1m]` with 1M context window metadata

## 0.2.0

- Added `claude-opus-4-7` to default models

## 0.1.0

- Initial release
- Added `vertex-anthropic` custom provider for pi
- Supports Anthropic partner models on Google Vertex AI via ADC
- Includes default models: Opus 4.6, Sonnet 4.6, Haiku 4.5
