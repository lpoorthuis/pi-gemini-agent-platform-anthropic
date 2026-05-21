# Changelog

## Unreleased

- No unreleased changes.

## 0.6.0

- **Breaking:** Removed environment-variable aliases. Each configuration knob is now read from exactly one name. Migration:
  - Project: use `GOOGLE_CLOUD_PROJECT` (removed `GOOGLE_AGENT_PLATFORM_PROJECT`, `AGENT_PLATFORM_PROJECT_ID`, `ANTHROPIC_AGENT_PLATFORM_PROJECT_ID`).
  - Regional location: use `GOOGLE_CLOUD_LOCATION` (removed `GOOGLE_AGENT_PLATFORM_LOCATION`, `AGENT_PLATFORM_ANTHROPIC_REGIONAL_LOCATION`).
  - Multi-region location: use `AGENT_PLATFORM_ANTHROPIC_MULTI_LOCATION` (removed `ANTHROPIC_AGENT_PLATFORM_LOCATION`).
  - Multi-region base URL: use `AGENT_PLATFORM_ANTHROPIC_BASE_URL` (removed `ANTHROPIC_AGENT_PLATFORM_BASE_URL`).
  - Access token override: use `GOOGLE_OAUTH_ACCESS_TOKEN` (removed `AGENT_PLATFORM_ACCESS_TOKEN`).
- Added `envFirst()` helper to centralize environment-variable lookup.
- Fixed a latent inconsistency where `resolveRegionalLocation` and `resolveMultiRegionProfile` read the same regional aliases in different priority orders.

## 0.5.0

- Renamed package metadata and documentation to `agent-platform-anthropic-pi`.
- Removed obsolete pre-rebrand environment-variable aliases from code and documentation.
- Changed the default multi-region location to `eu`, with `europe-west1` as the default regional fallback.
- Added public Anthropic token-cost defaults so pi usage and cost tracking report non-zero costs.
- Added in-memory caching for Google Application Default Credentials access tokens to avoid a `gcloud` shell-out on every request.
- Changed default model display names to concise Claude names.
- Improved the missing-project first-run error with copy-paste setup commands.
- Changed unknown custom model fallback context window to a conservative `200,000` tokens.
- Added dash-form Haiku snapshot normalization for users who configure `claude-haiku-4-5-20251001`.
- Added `AGENT_PLATFORM_ANTHROPIC_ADAPTIVE_MODELS` for future adaptive-thinking model snapshots.
- Added debug-gated stream parse warnings via `AGENT_PLATFORM_ANTHROPIC_DEBUG=1`.
- Tightened context-overflow normalization scoping to the active Gemini Enterprise Agent Platform Anthropic provider.
- Updated `claude-sonnet-4-6` max output tokens to `128,000`.

## 0.4.0

- Rebranded the extension for Google Gemini Enterprise Agent Platform.
- Added provider name `agent-platform-anthropic`.
- Added Agent Platform env var aliases (`AGENT_PLATFORM_*`, `ANTHROPIC_AGENT_PLATFORM_*`).
- Updated docs to clarify Claude partner models use the Agent Platform API host `aiplatform.googleapis.com` and `:streamRawPredict`.
- Restored current documented Claude thinking request format (`thinking.type: enabled` with `budget_tokens`).
- Added dual endpoint routing support (multi-region + regional fallback) per model.
- Added per-model endpoint override support.
- Added per-model context window / max token defaults and overrides.
- Added support for Claude-style default model env vars (`ANTHROPIC_DEFAULT_*`).
- Changed default routing for `claude-opus-4-7` to prefer multi-region with regional fallback.
- Improved endpoint fallback errors to include all attempted endpoints.
- Added automatic multi-region inference from base URL / regional location.
- Updated `claude-opus-4-7` default to 1M context and 128k max output tokens.

## 0.2.0

- Added `claude-opus-4-7` to default models.

## 0.1.0

- Initial release.
- Added a custom provider for pi.
- Supports Anthropic partner models on Google Gemini Enterprise Agent Platform via ADC.
- Includes default models: Opus 4.6, Sonnet 4.6, Haiku 4.5.
