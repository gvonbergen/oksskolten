-- Persist the original RSS fallback content at ingestion time.
--
-- Articles hydrated from RSS inline content (SPA / bot-blocked /
-- extraction-thin pages) store the raw listing excerpt that produced their
-- full_text. Redownload reuses this stored excerpt through the same
-- fallback pipeline, so the operation stays deterministic even if the
-- article disappears from the live feed. The column is base-table only: it
-- is not exposed through the active_articles view or any retrieval API.

ALTER TABLE articles ADD COLUMN rss_excerpt TEXT;