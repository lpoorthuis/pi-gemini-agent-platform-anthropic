# vertex-anthropic-pi

Pi extension package to use Anthropic partner models (Claude) through Google Vertex AI.

## What this provides

Registers a custom provider in pi:

- `vertex-anthropic`

Default models exposed:

- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5@20251001`

## Requirements

- `gcloud` CLI installed and available in `PATH`
- Application Default Credentials configured:

```bash
gcloud auth application-default login
```

- Vertex env vars set:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
export GOOGLE_CLOUD_LOCATION="europe-west1"
```

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
pi --provider vertex-anthropic --model claude-opus-4-6
```

List provider models:

```bash
pi --list-models | rg vertex-anthropic
```

## Optional configuration

Override default model list:

```bash
export VERTEX_ANTHROPIC_MODELS="claude-opus-4-6,claude-sonnet-4-6,claude-haiku-4-5@20251001"
```

Token override (if needed):

```bash
export GOOGLE_OAUTH_ACCESS_TOKEN="..."
# or
export VERTEX_ACCESS_TOKEN="..."
```

## Versioning and updates

- Use semantic versions and git tags (`v0.1.0`, `v0.2.0`, ...).
- Recommend teammates install pinned tags.
- Update with:

```bash
pi update
```
