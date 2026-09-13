# ADR-002: Soft delete for article retention policy

## Status

Accepted

## Context

Issue #10 required implementing a retention policy that automatically deletes old articles. This addresses the problem of unbounded database growth by removing read/unread articles after configurable retention periods.

Two deletion strategies were considered:

1. **Hard delete + separate table**: `DELETE` the article rows and record purged URLs in a `purged_article_urls` table
2. **Soft delete**: Add a `purged_at` column and NULL out content columns, keeping the rows themselves

### Problems with hard delete

During feed fetching, `getExistingArticleUrls()` checks which URLs already exist in the DB so that only new articles are passed to `insertArticle()` (backed by a UNIQUE constraint on `articles.url`). Hard-deleting a row would cause the next fetch cycle (every 5 minutes) to treat that URL as "new" and re-insert it.

Preventing this would require modifying `getExistingArticleUrls()` to also query the purged-URLs table. Because feed fetching is a critical path, the added complexity and bug risk were undesirable.

## Decision

**Soft delete** was adopted, with an `active_articles` VIEW to centralize the filter.

### Mechanism

- Add a `purged_at TEXT` column to the `articles` table (`migrations/0006_retention.sql`)
- On purge:
  - NULL out `full_text`, `full_text_translated`, `excerpt`, `summary`, and `og_image` (reclaims storage)
  - Set `purged_at = datetime('now')`
  - Remove the article from the search index
  - Delete any archived images
- Articles with `bookmarked_at` or `liked_at` set are excluded from purging

### Impact on feed fetching

- `getExistingArticleUrls()` requires **no changes** — URLs remain in the `articles` table, so existing duplicate checks continue to work
- The UNIQUE constraint on `insertArticle()` also continues to function

### `active_articles` VIEW

Manually adding `purged_at IS NULL` to every read query proved error-prone — several queries were initially missed, causing purged articles to still appear in sidebar counts, chat tools, and suggestions.

To centralize the filter, an `active_articles` VIEW was introduced (`migrations/0007_active_articles_view.sql`):

```sql
CREATE VIEW active_articles AS
SELECT * FROM articles WHERE purged_at IS NULL;
```

RSS article deletion later reuses the same mechanism (`migrations/0009` / `0011` rebuild the view with an extra filter):

```sql
CREATE VIEW active_articles AS
SELECT * FROM articles WHERE purged_at IS NULL AND hidden_at IS NULL;
```

**Rules:**
- **Read queries** (SELECT): use `FROM active_articles` / `JOIN active_articles`
- **Write queries** (INSERT/UPDATE/DELETE): use the base `articles` table directly
- **`getExistingArticleUrls()`**: uses the base `articles` table (must include purged and hidden URLs)
- **Purge functions**: use the base `articles` table (they manage `purged_at` directly)

This makes the rule simple: if you're reading articles for display or aggregation, use the VIEW. If you see `FROM articles` in a SELECT, it should be intentional (write support, URL dedup, or purge logic).

### Soft-hide for RSS article deletion (`hidden_at`)

Deleting an RSS article applies the same soft-delete pattern as purge, for the same reason: the row stays in the base `articles` table so the feed poll's duplicate check (`getExistingArticleUrls()`) can never re-import a URL the user removed. Hidden rows are excluded from every retrieval API and their search-index document is removed at hide time; retention later hard-purges the tombstone. When a hidden RSS article is re-clipped, the route resurrects it (`hidden_at` cleared, moved to the clip feed), and an `rss_origin` marker survives that reclassification so a second delete still soft-hides the row instead of hard-deleting the tombstone.

### Why `seen_at` (not `read_at`) for read-article retention

The retention window for "read" articles is based on `seen_at`, not `read_at`. This application distinguishes two timestamps:

| Column | Meaning | Set when |
|--------|---------|----------|
| `seen_at` | Article marked as read (no longer unread in the UI) | Scroll-mark-as-read, bulk mark-all-read, etc. |
| `read_at` | Article content actually viewed | User opens the article detail page |

`read_at` exists to power **read history** — a filtered view of articles the user truly opened — without noise from scroll-dismissed items. It is deliberately separated from `seen_at` so that read history remains meaningful.

For retention, the relevant question is "has the user decided this article is no longer needed?" — which maps to `seen_at`. Using `read_at` would leave scroll-dismissed articles (never opened, just triaged away) in the database indefinitely, defeating the purpose of the retention policy.

## Consequences

### Benefits

- No changes required to the critical feed-fetching path
- Simple migration (column addition only, no new tables)
- Content columns account for most of the storage, so NULLing them provides substantial space reclamation
- Row metadata (URL, title, timestamps) is preserved, enabling future historical analytics
- The `active_articles` VIEW prevents accidental omission of the purge filter in new queries

### Drawbacks

- New read queries must use `active_articles` instead of `articles`. Using the base table in a SELECT is easy to do by mistake, though easier to catch in review than a missing WHERE clause
- Rows themselves remain, so URL and metadata storage continues (on the order of a few hundred bytes per row)
- SQLite does not actually free the NULLed storage until VACUUM is run (mitigated by a weekly VACUUM cron job)
