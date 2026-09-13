# Oksskolten Spec — Clip

> [Back to Overview](./01_overview.md)

## Overview

A feature that allows users to manually save (clip) arbitrary URLs. Articles are ingested through a flow independent of RSS feeds.

## Motivation

Addresses the need to save articles without subscribing to a feed — one-off viral posts, articles from sites not worth a full subscription, etc. Similar to Pocket's 'save for later' model, but integrated into the RSS reader so clipped articles share the same reading experience (summaries, translations, bookmarks, search).

## Design

### Clip Feed

Clipped articles belong to a special singleton feed called the "clip feed." This allows article management (read status, bookmarks, summaries, translations, search, etc.) to be fully unified with regular RSS articles.

| Aspect | RSS Feed | Clip Feed |
|---|---|---|
| `type` in DB | `'rss'` | `'clip'` |
| `url` | Blog URL | `'clip://saved'` |
| Count | Multiple | Singleton (only one) |
| Article addition | Automatic via Cron | Manual by user via `POST /api/articles/from-url` |
| Cron target | Retrieved by `getEnabledFeeds()` | Excluded (only `type = 'rss'` is retrieved) |
| Sidebar placement | Feed list section (with categories) | Special section (alongside Inbox, Bookmarks, and Likes) |
| Global unread count | Included | Not included |
| Category | Can belong to one | Not allowed |
| Smart Floor | Applied | Not applied (all saved articles always visible) |
| Article deletion | Soft-hide: delete marks `hidden_at` (row kept for the feed-poll dup check, excluded from retrieval and search; retention purges it later) | Hard delete (`DELETE /api/articles/:id`) |
| Feed deletion | Allowed | Not allowed (403) |
| Icon | Domain favicon | Archive icon |

### DB Functions

| Function | Description |
|---|---|
| `ensureClipFeed()` | Retrieves the clip feed. Creates and returns it if it does not exist (idempotent) |
| `getClipFeed()` | Retrieves the clip feed. Returns `undefined` if not yet created |
| `getEnabledFeeds()` | Returns only feeds where `disabled = 0 AND type = 'rss'` (excludes clip) |
| `deleteArticle(id)` | Hard-deletes an article (clip delete). Returns `true` on success, `false` if not found |
| `hideArticle(id)` | Soft-deletes an RSS-origin article (sets `hidden_at`; RSS delete). Returns `true` on success, `false` if not found |

### Clip Save Flow

```
User enters a URL
    │
    ▼
POST /api/articles/from-url
    │
    ├─ 1. getClipFeed() → 500 if not found
    ├─ 2. getArticleByUrl() → 409 if already exists
    ├─ 3. fetchArticleContent(url) → Shared fetch pipeline (see below)
    │     On failure: record in last_error and continue with full_text = NULL (graceful degradation)
    ├─ 4. Title resolution: request.title > fetchedTitle > hostname
    └─ 5. insertArticle() → 201
```

After saving, the article supports summary, translation, bookmark, like, and chat — just like regular RSS articles.

### Shared Fetch Pipeline with RSS Feeds

Clip and RSS feeds use the same `fetchArticleContent()` function (`server/fetcher.ts`), which handles full-text retrieval, FlareSolverr fallback, bot-block detection, and language detection in a unified pipeline. The difference lies in the options passed:

| Capability | RSS Feed | Clip |
|---|---|---|
| `fetchFullText` + automatic FlareSolverr fallback (short/garbage extraction) | Yes | Yes |
| `isBotBlockPage` detection | Yes | Yes |
| `detectLanguage` (local CJK ratio) | Yes | Yes |
| `requiresJsChallenge` (explicit FlareSolverr via feed-level flag) | Yes (from `feeds.requires_js_challenge`) | No (`undefined` — automatic fallback only) |
| `listingExcerpt` (CSS Bridge excerpt fallback) | Yes (from RSS item excerpt) | No (not applicable) |
| `existingArticle` (skip fetch on retry) | Yes (for retry articles) | No (not applicable) |

The last two options are inherently not applicable to clips: there is no CSS Bridge listing page and no retry mechanism for manually saved articles. The `requiresJsChallenge` flag is a per-feed setting that does not exist for clips; however, the automatic FlareSolverr fallback in `fetchFullText()` (triggered when extracted content is too short or looks like garbage) still applies.
