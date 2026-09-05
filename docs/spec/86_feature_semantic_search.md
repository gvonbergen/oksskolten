# Oksskolten Spec — Semantic Search (Embeddings)

> [Back to Overview](./01_overview.md)

## Overview

Semantic search extends the existing Meilisearch full-text search with
embedding-assisted retrieval. Each article is represented by an embedding of
its **title + summary**; queries are embedded at search time and blended with
keyword ranking using Meilisearch's managed hybrid search. This resolves
[issue #117](https://github.com/babarot/oksskolten/issues/117): the embedder is
first-class managed index configuration, so the periodic six-hour rebuild and
startup reconciliation never drop it.

## Motivation

- **Better recall for paraphrased queries.** Keyword search misses articles
  that use different wording than the query; embedding-assisted hybrid search
  closes that gap without abandoning the existing keyword ranking.
- **Embeddings must survive index rebuilds.** Historically embedder settings
  were re-applied inconsistently across index lifecycle paths (staging rebuild,
  first-run production, populated-startup reconcile), causing semantic search
  to silently degrade to keyword-only (#117). Making the embedder part of the
  managed index settings fixes this at the root.
- **Privacy-conscious opt-in.** Embeddings send title + summary to a provider,
  so they are separately opt-in with a clear cloud-data warning, and never
  include full article body text.

## Design

### Product rules (v1)

- **Disabled by default.** A fresh installation has embeddings OFF.
- **Opt-in only.** Enabling happens through Settings → Integration →
  *Semantic Search*. Configuring summarization never enables embeddings.
- **Prerequisite.** Embeddings can be enabled **only when automatic article
  summarization is configured and enabled** (`summary.auto=on` plus a
  configured summary provider/model). Enforced by the settings API (server
  validation) and reflected in the UI; API calls cannot bypass it. If the
  prerequisite is lost later (e.g. automatic summarization switched off),
  semantic search stops operating at runtime (keyword-only) and the settings
  UI explains the dependency.
- **English-only retrieval.** v1 does not promise cross-language recall.
- **Input is title + summary only.** Full article text is never embedded.
- **Separate credential.** The embedding provider uses its own API key
  (`embedding.api_key`), never implicitly reusing a chat key. Secrets are
  written into the persisted Meilisearch embedder settings but are never
  returned by any API endpoint.
- **Duplicate detection unchanged.** Similar-story detection stays a
  deterministic title + Dice algorithm; semantic relatedness is not duplicate
  detection and does not affect auto-mark-read behavior.

### Settings keys

Stored in the SQLite `settings` table (see [ADR 001](./../adr/001-settings-dual-storage.md)):

| Key | Meaning |
|---|---|
| `summary.auto` | `on`/`off` — automatic summary generation for new articles (also the embedding prerequisite) |
| `embedding.enabled` | `on`/`off` |
| `embedding.provider` | `openai` (cloud) or `ollama` (local) |
| `embedding.model` | Provider-specific embedding model (e.g. `text-embedding-3-small`, `nomic-embed-text`) |
| `embedding.dimensions` | Optional explicit vector dimension (must match model output) |
| `embedding.base_url` | Optional endpoint override (OpenAI-compatible URL, or Ollama server URL) |
| `embedding.api_key` | Secret credential; never exposed to clients |

### Architecture

- **Managed embedder.** `buildEmbeddersSettings(config)` compiles the current
  embedding config into a Meilisearch `embedders` object (named
  `article-v1`). `resolveIndexSettings()` appends it to the existing keyword
  settings; **every** index generation (staging rebuild, first-run production,
  populated-startup reconcile) applies the same object. When disabled, the
  settings are exactly the previous keyword config.
- **Document shape.** Documents carry a `summary` field used only by the
  embedder template `{{doc.title}}\n\n{{doc.summary}}` (keyword
  `searchableAttributes` are unchanged). Articles **without** a summary are
  indexed with `_vectors: { "article-v1": null }`, which makes Meilisearch skip
  embedding generation for them (verified against the pinned v1.13 image by
  `scripts/smoke-embedding.ts`). No embedding is ever generated from a
  title-only article; once `updateArticleContent` writes a summary, the
  re-upserted RSS document is embedded automatically and idempotently.
  Manually clipped (`clip`) articles are intentionally excluded from automatic
  summarization and embeddings in v1, including after a manual summary.
- **Staging rebuild.** Enabling, disabling, or changing provider/model/
  dimensions/base_url triggers `requestSearchRebuild()`: the app builds a fresh
  `articles_staging` index with the managed embedder, batches in all active
  articles, waits for tasks (aborting before the swap if a document batch
  failed, e.g. embedding generation failure), swaps atomically, and deletes the
  old index. Concurrent rebuilds are guarded (`rebuilding` flag + HTTP 409).
- **Embedding proxy token.** Meilisearch reaches OpenAI-compatible/Ollama
  endpoints through the app's internal proxy
  (`/api/internal/embedding-proxy/<token>/...`), and the full URL including the
  token is persisted in the embedder settings. The token is therefore resolved
  once and kept stable: explicit `EMBEDDING_PROXY_TOKEN` wins, otherwise the
  token persisted in `.env` on first start is reused (production deployments
  should set the variable explicitly — compose passes it through). A changing
  token would rewrite the embedder URL on every boot and force a full
  re-embedding.
- **Query path.** `searchArticlesWithHybrid()` runs the Meilisearch query with
  `hybrid: { embedder: "article-v1", semanticRatio: 0.25 }` only when
  `isSemanticReady()` — enabled + prerequisite met + provider credential
  present + live index carries the expected embedder. On a thrown embedding
  error it retries the same query once keyword-only and reports
  `search_mode: "keyword-fallback"` instead of returning empty results.
- **Readiness.** `semantic_ready` is computed from config + live-index
  verification (`verifyLiveEmbedder()` compares persisted embedder settings
  with the expected non-secret fingerprint at startup). On populated startup,
  database article and summary counts are compared with Meilisearch document
  and vector counts; incomplete legacy coverage schedules one guarded repair
  rebuild before semantic readiness is reported. Index stats
  (documents/embeddedDocuments/embeddings) are polled from Meilisearch with a
  short TTL and surfaced in the settings UI. Rebuild status includes processed
  and total document counts.

### Providers

- **OpenAI** — native Meilisearch embedder (`source: openAi`),
  `text-embedding-3-small` default (1536 dims), requires the embedding API key.
  Optional `base_url` for OpenAI-compatible endpoints. HTTPS enforced for
  cloud URLs.
- **Ollama** — native Meilisearch embedder (`source: ollama`), e.g.
  `nomic-embed-text`; uses `embedding.base_url` (default
  `http://localhost:11434`). In `docker compose` deployments, Meilisearch must
  reach Ollama — the compose files add `extra_hosts: host.docker.internal ->
  host-gateway` for Linux; on Docker Desktop it resolves automatically.

Neither provider sends full article text: only title + summary, per the
embedder template. Cloud providers receive that content for embedding
generation; the UI shows a privacy notice before activation that reflects the
selected provider (cloud transfer for OpenAI, local endpoint wording for
Ollama).

### Automatic summarization

When `summary.auto` is `on` and the summary provider/model are configured, the
fetch pipeline (`processArticle`) fires `autoSummarizeArticle()` for each newly
ingested RSS article with full text, and again when a retried article first
obtains its full text. URL-clipped articles are intentionally not scheduled for
automatic summarization. Summaries persist via `updateArticleContent`, which
also re-upserts the search document — making an eligible RSS article eligible
for embedding.
Failures are logged and never block article availability (on-demand
summarization remains available from the article UI).

### API

#### GET /api/settings/search-embedding

Non-secret configuration + prerequisite + runtime status:

```json
{
  "enabled": "on",
  "provider": "openai",
  "model": "text-embedding-3-small",
  "dimensions": 1536,
  "base_url": null,
  "api_key_configured": true,
  "prerequisite": { "met": true, "autoSummaryEnabled": true, "summaryProvider": "openai", "summaryModel": "gpt-4.1-mini", "reason": null },
  "semantic_ready": true,
  "rebuilding": false,
  "last_rebuild": { "startedAt": 0, "finishedAt": 0, "ok": true, "error": null, "documents": 45342, "processedDocuments": 45342, "totalDocuments": 45342 },
  "index": { "documents": 45342, "embeddedDocuments": 45100, "embeddings": 45100 }
}
```

Never contains the credential. `prerequisite.reason` explains the first unmet
dependency when `met` is false.

#### PATCH /api/settings/search-embedding

Updates `enabled`, `provider`, `model`, `dimensions`, `base_url`. Enabling
(`enabled:"on"`) is rejected with HTTP 400 unless the prerequisite is met, an
embedding credential exists for cloud providers, and the provider/model are
set. Embedder-relevant changes kick an asynchronous rebuild (never awaited by
the caller); configuration and credential changes are rejected with HTTP 409
while a rebuild is active. Disabling rebuilds keyword-only so no embedder is
left behind.

#### POST /api/settings/search-embedding/key

Body `{ "apiKey": "..." }` stores the credential; empty string deletes it.
Responses only ever report `configured`.

#### POST /api/settings/search-embedding/test

Validates provider/model/credential connectivity with a one-request probe
(`POST /v1/embeddings` for OpenAI, `POST /api/embed` for Ollama) against
real APIs, including optional candidate overrides, and checks the returned
vector dimension. Used by the "Test connection" button and available for
tooling.

#### POST /api/settings/search-embedding/rebuild

Triggers an asynchronous backfill/reindex of all articles (title+summary).
Returns 400 when disabled, 409 while a rebuild is already running.

#### GET /api/articles/search

Extended response with `search_mode`: `"keyword"`, `"hybrid"`, or
`"keyword-fallback"`. Existing fields (`articles`, `has_more`) and all filters,
pagination, and ranking are unchanged. 503 still means the keyword index is
not built. A semantic failure yields keyword results, never an empty response
caused only by embedding failure.

### Chat / MCP

`search_articles` uses the same hybrid + keyword-fallback path automatically.
Its description was updated to "hybrid semantic + keyword search when
available; keyword fallback otherwise". A server-side log line records actual
fallbacks; the tool's JSON array output format is unchanged. `get_similar_articles`
stays keyword-based (semantic relatedness is not duplicate detection).

### Failure & operational behavior

- Provider down at indexing time → document batch task fails → rebuild aborts
  before swap → previous production index stays usable (keyword + stale
  semantic). `last_rebuild.error` surfaces it.
- Provider down at query time → hybrid request fails → keyword fallback with
  `search_mode: "keyword-fallback"`; the search dialog shows a discreet notice.
- Provider down while the index is live → new-article upserts fail and are
  logged; the next successful rebuild reconciles them.
- Config changes never mutate a live embedder in place — they trigger a staging
  rebuild (Meilisearch regenerates every document's vectors when embedder
  settings change, which stalls on a dead endpoint; staging keeps that off the
  live index).

### Testing

- Unit: config compiler (disabled/openai/ollama), prerequisite logic, secret
  redaction, non-secret fingerprint, per-document `_vectors` handling,
  connectivity probe (mocked HTTP).
- Sync lifecycle: staging receives embedder settings before documents; startup
  reconciliation re-applies them to a populated index (#117 regression);
  failed document batches abort before swap; disabling rebuilds keyword-only;
  no duplicate concurrent rebuilds.
- Query layer: hybrid request formation with filters/pagination/sort; one
  keyword retry on embedding failure; keyword-only when disabled.
- Routes: prerequisite enforcement, secret redaction, rebuild triggers,
  hybrid/fallback `search_mode`, 503 unchanged, connection test.
- Fetcher: auto-summarization on/off and retry path.
- Pinned Meilisearch smoke (`npm run smoke:embedding`): `_vectors:null` skips
  embedding, embedder survives the create/settings/add/swap/delete cycle,
  hybrid ranking + filters, keyword survives endpoint death.