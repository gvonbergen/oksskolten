-- Durable RSS-origin marker for the article delete tombstone.
--
-- A hidden RSS article can be re-clipped: the from-url route resurrects
-- the row into the clip feed (feed_id changes, hidden_at cleared). If that
-- resurrected row were later hard-deleted because it now belongs to the
-- clip feed, the row would disappear and the original RSS feed poll's
-- duplicate check would re-import the URL the user had deleted twice.
--
-- rss_origin records where an article row came from (1 = RSS, 0 = clip, as
-- an explicit column). It survives feed reclassification, so a second
-- delete of a resurrected RSS article soft-hides the row again instead of
-- hard-deleting it, and the feed-poll tombstone is never destroyed.

ALTER TABLE articles ADD COLUMN rss_origin INTEGER NOT NULL DEFAULT 0;

-- SQLite views freeze their column list at creation time, so a column
-- added after migration 0009 must be re-exposed by rebuilding the view
-- that every retrieval API reads through.
DROP VIEW IF EXISTS active_articles;
CREATE VIEW active_articles AS
SELECT * FROM articles WHERE purged_at IS NULL AND hidden_at IS NULL;

-- Backfill existing rows: articles owned by a non-clip feed came from RSS
-- ingestion. (Rows already moved into the clip feed before this upgrade —
-- the rare resurrected-before-migration case — are labelled as clips.)
UPDATE articles
SET rss_origin = 1
WHERE rss_origin = 0
  AND feed_id IN (SELECT id FROM feeds WHERE type != 'clip');