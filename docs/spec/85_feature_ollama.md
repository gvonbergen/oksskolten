# Oksskolten Spec — Ollama LLM Provider

> [Back to Overview](./01_overview.md)

## Overview

Add Ollama as a self-hosted LLM provider. Ollama runs locally or on a private server and exposes an OpenAI-compatible chat completion API. This allows users to run summarization, translation, and chat entirely on their own hardware without sending data to external APIs.

## Motivation

- **Privacy**: Article content stays on the user's network; no data is sent to third-party APIs.
- **Cost**: No per-token charges. Useful for high-volume summarization/translation workloads.
- **Offline**: Works without internet access once models are downloaded.
- **Flexibility**: Users can run any GGUF model available in the Ollama library.

## Design

### OpenAI-Compatible API

Ollama exposes `/v1/chat/completions` that is compatible with the OpenAI SDK. The Ollama provider reuses the `openai` npm package with a custom `baseURL` pointing to the Ollama server. This avoids adding a new SDK dependency.

### Provider Registration

A new `ollama` provider is added to the existing LLM provider system:

- **Provider key**: `ollama`
- **API key**: Not required. `requireKey()` is a no-op, same as `claude-code`. Connection errors surface naturally when `createMessage`/`streamMessage` is called.
- **Base URL**: Resolved in order: (1) `ollama.base_url` DB setting, (2) `OLLAMA_BASE_URL` environment variable, (3) `http://localhost:11434`. The environment variable allows Docker Compose to set `http://host.docker.internal:11434` without requiring UI configuration. No SSRF protection is needed since Oksskolten is a single-user self-hosted application where only the server owner can configure settings.
- **Client**: Uses the `openai` npm package with `baseURL` set to `{ollama.base_url}/v1` and a placeholder API key (`ollama`). Custom headers are passed via `defaultHeaders` if configured.

### Custom Headers

Ollama may be exposed through a reverse proxy (e.g. Cloudflare Tunnel) that requires authentication headers. Users can configure custom HTTP headers that are attached to all Ollama requests.

- **Storage**: `ollama.custom_headers` in the settings DB as a JSON string (e.g. `{"CF-Access-Client-Id":"xxx","CF-Access-Client-Secret":"yyy"}`). Same pattern as `images.upload_headers`.
- **OpenAI SDK**: Passed via the `defaultHeaders` option in the OpenAI client constructor. This ensures headers are sent on every chat completion request.
- **Settings API endpoints**: The `/api/settings/ollama/models` and `/api/settings/ollama/status` endpoints also include these headers in their `fetch()` calls to the Ollama server.
- **Client cache key**: The client is re-created when either the base URL or the headers JSON changes.
- **UI**: The `OllamaCard` component includes a "Custom Headers" section below the base URL input. Each header is an editable key-value pair with add/remove controls. Both key and value are plain text fields (not masked) for ease of editing. Headers are stored as JSON on save.
- **Validation**: The headers JSON must be a flat `Record<string, string>` (no nested objects). Invalid JSON or non-string values are rejected with a 400 error on save.

### Dynamic Model Discovery

Unlike other providers that have a static model list, Ollama models are user-installed and vary per instance. The provider discovers available models by calling the Ollama REST API:

```
GET {base_url}/api/tags
```

Response shape (relevant fields):

```json
{
  "models": [
    {
      "name": "llama3.2:latest",
      "size": 2019393189,
      "details": {
        "parameter_size": "3B",
        "family": "llama"
      }
    }
  ]
}
```

The model list endpoint is exposed via a new API route so the frontend can populate a dynamic model selector.

### Token Usage and Billing

Ollama returns token usage in the OpenAI-compatible response format (`usage.prompt_tokens`, `usage.completion_tokens`). These are recorded the same way as other providers. If the response omits usage data, zeros are recorded.

`AiBillingMode` in `server/fetcher/ai.ts` is extended with `'ollama'`. Since Ollama is local, pricing is zero. `getModelPricing()` returns `undefined` for dynamic Ollama models; the UI displays "Local" or "—" where cost would normally appear.

### Chat Adapter

The chat adapter reuses `runOpenAITurn()` from `adapter-openai.ts` by adding an optional `externalClient` parameter. When the provider is `ollama`, `adapter.ts` passes the Ollama client to `runOpenAITurn()`. No separate `adapter-ollama.ts` is needed. When `externalClient` is provided, the OpenAI API key check is skipped.

### Streaming

Ollama supports streaming via the OpenAI-compatible SSE format. The `streamMessage()` implementation follows the same pattern as the OpenAI provider.

### Configuration

All Ollama settings are stored in the SQLite settings table, consistent with other providers. The base URL and custom headers are saved via the existing preferences API (`PATCH /api/settings/preferences`) by adding `ollama.base_url` and `ollama.custom_headers` to `PREF_KEYS` and `PREF_ALLOWED` (both with `null` to accept any string).

| Setting Key | Type | Default | Description |
|---|---|---|---|
| `ollama.base_url` | string | `$OLLAMA_BASE_URL` or `http://localhost:11434` | Ollama server address |
| `ollama.custom_headers` | string (JSON) | `""` | Custom HTTP headers as JSON object (e.g. `{"CF-Access-Client-Id":"..."}`) |
| `chat.provider` | string | — | Set to `ollama` to use Ollama for chat |
| `chat.model` | string | — | Ollama model name (e.g. `llama3.2:latest`) |
| `summary.provider` | string | — | Set to `ollama` for summarization |
| `summary.model` | string | — | Ollama model name |
| `translate.provider` | string | — | Set to `ollama` for translation |
| `translate.model` | string | — | Ollama model name |

### Settings UI

The settings page adds:

- A dedicated `OllamaCard` component (analogous to `ClaudeCodeCard`) under the LLM provider section. It displays a base URL text input (not a secret field) and a "Test Connection" button that calls `GET /api/settings/ollama/status`, showing success with version and model count, or an error message.
- When `ollama` is selected as a provider for any task, the model dropdown is populated dynamically from the Ollama instance instead of a static list.

Ollama is always shown as "configured" in the provider button group (no API key required). The `configuredKeys` map hardcodes `ollama: true`. When the user switches to `ollama`, the frontend fetches `/api/settings/ollama/models` and auto-selects the first available model. The `ModelSelect` component branches internally: for `provider === 'ollama'`, it uses SWR to fetch the dynamic model list; for other providers, it uses the existing static `getModelGroups()` helper.

### Model Validation

Since Ollama models are dynamic, the `validateProviderModel()` function in `settings.ts` skips model validation when provider is `ollama` (similar to `google-translate` and `deepl`). Additionally, `PREF_ALLOWED` for `chat.model`, `summary.model`, and `translate.model` is set to `null` (accept any string) rather than `getAllModelValues()`, because dynamic Ollama model names would otherwise be rejected on save. The `validateProviderModel()` function still enforces model validity for static providers.

### `shared/models.ts` Changes

- Add `ollama` to `DEFAULT_MODELS` with empty string (no static default).
- Add `ollama` to `PROVIDER_LABELS` with label key `provider.ollama`. The i18n value is `"Ollama"` in both English and Japanese.
- Add `ollama` to `LLM_TASK_PROVIDERS`.
- Add `ollama` to `SUB_AGENT_MODELS` with empty string (user must configure).
- `MODELS_BY_PROVIDER` does **not** include `ollama` (models are dynamic, not static).

### API Endpoints

**List Ollama Models** — `GET /api/settings/ollama/models`

Proxies a request to `{ollama.base_url}/api/tags` and returns the model list. Returns `[]` if Ollama is unreachable. Response: `{ "models": [{ "name": "llama3.2:latest", "size": 2019393189, "parameter_size": "3B" }] }`

**Test Ollama Connection** — `GET /api/settings/ollama/status`

Checks connectivity by calling `GET {base_url}/api/version` and `GET {base_url}/api/tags`. Response: `{ "ok": true, "version": "0.9.0", "model_count": 5 }` or `{ "ok": false, "error": "Connection refused" }`

### Error Handling

| Scenario | Behavior |
|---|---|
| Ollama server unreachable | `createMessage`/`streamMessage` throws with connection error; caller handles as usual |
| Model not found | Ollama returns 404; surfaced as provider error |
| Base URL not configured | Uses default `http://localhost:11434` |
| Streaming interrupted | Same handling as OpenAI provider (partial text returned) |
| Token usage missing | Record `0` for both input and output tokens |
| Model list fetch fails | `/api/settings/ollama/models` returns `{ models: [] }`; UI shows "Cannot connect to Ollama" message |
| Custom headers invalid JSON | Preferences API returns 400; headers are not saved |
| Auth header rejected by proxy | Ollama returns 401/403; surfaced as provider error |

No Ollama-specific log fields. The existing AI task logging records `provider`, `model`, `inputTokens`, and `outputTokens`, which is sufficient.

### Test Plan

- **Unit tests** (`server/providers/llm/ollama.test.ts`): `createMessage`/`streamMessage` request format and token counts, client base URL from settings and default, `requireKey` no-throw, client cache invalidation on headers change, custom headers parsing and invalid JSON fallback.
- **Integration**: Manual test with a locally installed Ollama instance. Not required for CI. `compose.yaml` includes `OLLAMA_BASE_URL: http://host.docker.internal:11434` for Docker environments.

### Out of Scope

- **Pull models from UI**: Users must install models via `ollama pull` on the command line.
- **GPU/resource monitoring**: No visibility into Ollama's resource usage from within Oksskolten.
- **Model-specific parameters**: Temperature, top-p, and other sampling parameters are not configurable per-provider in the current architecture.
- **Ollama embeddings API**: Chat still uses the chat-completions API only; Ollama *embedding* models (e.g. `nomic-embed-text`) are supported via the semantic-search feature's Ollama embedder (see [86_feature_semantic_search.md](./86_feature_semantic_search.md)).

### Key Files

| File | Purpose |
|---|---|
| `server/providers/llm/ollama.ts` | Ollama LLM provider implementation |
| `server/providers/llm/index.ts` | Register `ollama` in the provider map |
| `server/chat/adapter.ts` | Add `ollama` routing case |
| `server/chat/adapter-openai.ts` | Add optional `externalClient` parameter to `runOpenAITurn()` |
| `server/fetcher/ai.ts` | Add `'ollama'` to `AiBillingMode` union |
| `shared/models.ts` | Add Ollama to provider constants and label map |
| `server/routes/settings.ts` | Add `ollama` to allowed provider values, add Ollama API endpoints |
| `src/pages/settings/sections/provider-config-section.tsx` | Add `OllamaCard` component |
| `src/pages/settings/sections/task-model-section.tsx` | Dynamic model selector for Ollama, configuredKeys |
| `src/lib/i18n.ts` | Add `provider.ollama` and Ollama-related i18n keys |
| `server/providers/llm/ollama.test.ts` | Unit tests for Ollama provider |
