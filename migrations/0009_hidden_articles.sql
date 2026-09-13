-- Soft-hide support for RSS article deletion (D1-C).
--
-- Deleting an RSS article used to be undone by the next feed poll: the
-- pipeline re-inserts any item whose normalized URL is not in the DB.
-- Instead of a hard delete, RSS articles are marked with hidden_at and
-- remain in the base table so the feed poll's duplicate check
-- (getExistingArticleUrls, which reads `articles` directly) keeps
-- treating them as existing and never resurrects them.
--
-- The refreshed active_articles view excludes hidden rows, so every
-- retrieval API (lists, search, by-url, by-id) treats them as absent.
-- The search-index document is removed at hide time; retention later
-- hard-purges the row like any other expired article.

ALTER TABLE articles ADD COLUMN hidden_at TEXT;

DROP VIEW IF EXISTS active_articles;
CREATE VIEW active_articles AS
SELECT * FROM articles WHERE purged_at IS NULL AND hidden_at IS NULL;
