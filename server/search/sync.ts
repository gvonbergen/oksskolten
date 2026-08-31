import type { Settings } from 'meilisearch'
import { getSearchClient, ARTICLES_INDEX, ARTICLES_STAGING_INDEX, type MeiliArticleDoc } from './client.js'
import { getDb } from '../db/connection.js'
import { SCORED_ARTICLES_WHERE } from '../db/articles.js'
import { logger } from '../logger.js'
import {
  applyEmbeddingVectors,
  buildEmbeddersSettings,
  getEmbeddingConfig,
  isEmbeddingPrerequisiteMet,
  matchesExpectedEmbedder,
} from './embedding.js'

const log = logger.child('search')

// --- State ---

let searchReady = false
let rebuilding = false

/**
 * True when the live production index carries the embedder configuration
 * expected by the current settings. Refreshed after every successful
 * rebuild and on startup verification; the settings API cannot change the
 * embedder config without triggering a rebuild, so this stays accurate
 * between rebuilds.
 */
let liveEmbedderVerified = false

interface RebuildRecord {
  startedAt: number
  finishedAt: number | null
  ok: boolean | null
  error: string | null
  documents: number | null
}

let lastRebuild: RebuildRecord | null = null

// Bounded cache for Meilisearch index stats (documents / embedded documents)
let statsCache: { documents: number; embeddedDocuments: number; embeddings: number; fetchedAt: number } | null = null
const STATS_CACHE_TTL_MS = 10_000

export function isSearchReady(): boolean {
  return searchReady
}

/**
 * Semantic readiness: embeddings are ON, the automatic-summarization
 * prerequisite is met, the embedding provider credential is present, and
 * the live index carries the expected embedder. Everything else (disabled,
 * prerequisite lost, stale index) means keyword-only behavior.
 */
export function isSemanticReady(): boolean {
  const config = getEmbeddingConfig()
  if (!config.enabled || !config.provider || !config.model) return false
  if (!isEmbeddingPrerequisiteMet()) return false
  if (config.provider === 'openai' && !config.apiKey) return false
  return liveEmbedderVerified
}

/** @internal Test-only helper to control rebuilding flag */
export function _setRebuilding(value: boolean): void {
  rebuilding = value
}

/** @internal Test-only helper to reset the searchReady flag between cases */
export function _setSearchReady(value: boolean): void {
  searchReady = value
}

/** @internal Test-only helper to control the live embedder verification flag */
export function _setLiveEmbedderVerified(value: boolean): void {
  liveEmbedderVerified = value
}

/** @internal Test-only helper to reset runtime/rebuild records between cases */
export function _resetRebuildRecord(): void {
  lastRebuild = null
  statsCache = null
}

// --- Change log for rebuild consistency ---

type ChangeEntry =
  | { action: 'upsert'; id: number; doc: MeiliArticleDoc }
  | { action: 'delete'; id: number }

let changeLog: ChangeEntry[] | null = null

// --- Index settings ---

const INDEX_SETTINGS: Omit<Settings, 'embedders'> = {
  searchableAttributes: ['title', 'full_text', 'full_text_translated'],
  filterableAttributes: ['feed_id', 'category_id', 'lang', 'published_at', 'is_unread', 'is_liked', 'is_bookmarked'],
  sortableAttributes: ['published_at', 'score'],
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
}

/**
 * Managed index settings. The embedder is first-class managed
 * configuration, so every index generation (staging rebuild, first-run
 * production, populated-startup reconciliation) receives the same object
 * and no index can ever lose the embedder you configured — the #117
 * regression. When embeddings are disabled the settings are exactly the
 * keyword config from before, preserving existing behavior.
 */
export function resolveIndexSettings(config = getEmbeddingConfig()): Settings {
  const embedders = buildEmbeddersSettings(config)
  return embedders ? { ...INDEX_SETTINGS, embedders } : { ...INDEX_SETTINGS }
}

// --- Rebuild ---

const BATCH_SIZE = 1000

// Meilisearch processes each task in a few seconds, but accumulated queue
// depth (score sync writes, individual article updates, prior rebuild batches)
// can keep a task waiting several minutes before it starts. The previous
// 60-second client wait timed out long before the task was even picked up,
// even when the server-side task itself succeeded. 5 minutes accommodates
// typical queue depth at ~10k articles; revisit if dataset grows further.
const MEILI_TASK_TIMEOUT_MS = 300_000

export async function rebuildSearchIndex(): Promise<void> {
  if (rebuilding) {
    log.info('Rebuild already in progress, skipping')
    return
  }
  rebuilding = true
  changeLog = []
  const config = getEmbeddingConfig()
  const settings = resolveIndexSettings(config)
  const embedderPlanned = !!buildEmbeddersSettings(config)
  lastRebuild = { startedAt: Date.now(), finishedAt: null, ok: null, error: null, documents: null }

  try {
    const client = getSearchClient()
    const startedAt = Date.now()

    // Collect existing index UIDs to avoid 404 requests
    const { results: existingIndexes } = await client.getIndexes()
    const indexSet = new Set(existingIndexes.map((idx: { uid: string }) => idx.uid))

    // 1. Create or reset staging index
    if (indexSet.has(ARTICLES_STAGING_INDEX)) {
      await client.deleteIndex(ARTICLES_STAGING_INDEX).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS })
    }
    await client.createIndex(ARTICLES_STAGING_INDEX, { primaryKey: 'id' }).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS })

    // 2. Apply index settings (including the managed embedder) to staging
    const stagingIndex = client.index(ARTICLES_STAGING_INDEX)
    await stagingIndex.updateSettings(settings).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS })

    // 3. Fetch all articles from SQLite and batch-insert into staging
    const rows = getDb().prepare(`
      SELECT id, feed_id, category_id, title,
             summary,
             COALESCE(full_text, '') AS full_text,
             COALESCE(full_text_translated, '') AS full_text_translated,
             lang,
             COALESCE(CAST(strftime('%s', published_at) AS INTEGER), 0) AS published_at,
             COALESCE(score, 0) AS score,
             (seen_at IS NULL) AS is_unread,
             (liked_at IS NOT NULL) AS is_liked,
             (bookmarked_at IS NOT NULL) AS is_bookmarked
      FROM active_articles
    `).all() as MeiliArticleDoc[]

    // SQLite returns 0/1 for boolean expressions; Meilisearch needs true/false
    const docs = rows.map((row) => applyEmbeddingVectors({
      ...row,
      is_unread: Boolean(row.is_unread),
      is_liked: Boolean(row.is_liked),
      is_bookmarked: Boolean(row.is_bookmarked),
    }, config))

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE)
      const task = await stagingIndex.addDocuments(batch).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS })
      // A failed document task with an embedder configured means embedding
      // generation is broken (bad credential, provider outage, dimension
      // mismatch). Abort before the swap so the previous production index
      // stays usable for both keyword and semantic search instead of
      // promoting an index that was never built.
      if (task && task.status === 'failed') {
        const message = task.error?.message || `document batch task ${task.uid} failed`
        throw new Error(`Meilisearch document indexing failed: ${message}`)
      }
    }

    // 4. Promote staging to production
    if (indexSet.has(ARTICLES_INDEX)) {
      // Swap articles <-> articles_staging, then clean up old data
      await client.swapIndexes([
        { indexes: [ARTICLES_INDEX, ARTICLES_STAGING_INDEX] } as any,
      ]).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS })
      await client.deleteIndex(ARTICLES_STAGING_INDEX).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS })
    } else {
      // First run: no existing articles index — create empty one for swap
      await client.createIndex(ARTICLES_INDEX, { primaryKey: 'id' }).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS })
      await client.swapIndexes([
        { indexes: [ARTICLES_INDEX, ARTICLES_STAGING_INDEX] } as any,
      ]).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS })
      await client.deleteIndex(ARTICLES_STAGING_INDEX).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS })
    }

    // 5. Replay change log
    if (changeLog && changeLog.length > 0) {
      const prodIndex = client.index(ARTICLES_INDEX)
      const upserts = changeLog.filter((e): e is Extract<ChangeEntry, { action: 'upsert' }> => e.action === 'upsert')
      const deletes = changeLog.filter((e): e is Extract<ChangeEntry, { action: 'delete' }> => e.action === 'delete')

      if (upserts.length > 0) {
        await prodIndex.addDocuments(upserts.map((e) => e.doc)).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS })
      }
      for (const del of deletes) {
        await prodIndex.deleteDocument(del.id)
      }
    }

    searchReady = true
    liveEmbedderVerified = embedderPlanned
    lastRebuild = { ...lastRebuild!, finishedAt: Date.now(), ok: true, error: null, documents: docs.length }
    statsCache = null
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    log.info(`Index rebuild complete: ${docs.length} articles in ${elapsed}s${embedderPlanned ? ' (embeddings enabled)' : ''}`)
  } catch (err) {
    // On failure: keep searchReady as-is (true if previously built, false if first time)
    const message = err instanceof Error ? err.message : String(err)
    log.error('Index rebuild failed:', err)
    lastRebuild = { startedAt: lastRebuild?.startedAt ?? Date.now(), finishedAt: Date.now(), ok: false, error: message, documents: lastRebuild?.documents ?? null }
  } finally {
    changeLog = null
    rebuilding = false
  }
}

/**
 * Idempotent startup hook for search. Inspects the Meilisearch state and
 * only triggers a full `rebuildSearchIndex()` if the articles index is
 * missing or empty. When the index is already populated — the common case
 * after a tsx-watch HMR restart or a normal prod redeploy — flip
 * searchReady on and return immediately.
 *
 * This avoids the race that happens when each restart fires a fresh
 * rebuild while the previous process's index-management tasks are still
 * in the Meilisearch queue (the symptom is "Index `articles_staging`
 * already exists" failures and waitTask timeouts piling up).
 *
 * The 6-hour cron continues to call `rebuildSearchIndex()` directly so a
 * full refresh still happens periodically.
 */
export async function ensureSearchIndex(): Promise<void> {
  // Step 1: existence and population check. Failures here usually mean
  // Meilisearch is unreachable, so we want to fall through to the rebuild
  // path so the startup retry loop can confirm whether Meili is back.
  let populatedDocCount = 0
  try {
    const client = getSearchClient()
    const { results: existingIndexes } = await client.getIndexes()
    const articles = existingIndexes.find((idx: { uid: string }) => idx.uid === ARTICLES_INDEX)
    if (articles) {
      const stats = await client.index(ARTICLES_INDEX).getStats()
      if (stats.numberOfDocuments > 0) {
        populatedDocCount = stats.numberOfDocuments
      }
    }
  } catch (err) {
    log.warn('ensureSearchIndex existence check failed; falling through to rebuild:', err)
  }

  if (populatedDocCount > 0) {
    // Step 2: schema sync. Apply current managed settings idempotently so a
    // redeploy that changed filterableAttributes / searchableAttributes —
    // or the managed embedder (enabled/disabled/provider/model) — picks up
    // the new shape without paying for a full rebuild. This is the startup
    // half of the #117 fix: a populated production index always has the
    // configured embedder re-applied.
    // Deliberately do NOT fall back to rebuildSearchIndex on failure here:
    // the only way this fails is Meilisearch queue pressure or a transient
    // error, and triggering a full rebuild (delete + create + swap +
    // batches) under that condition is exactly what produced the original
    // "Index articles_staging already exists" pile-up. Surface the error
    // to the startup retry loop instead so it backs off cleanly.
    const client = getSearchClient()
    await client.index(ARTICLES_INDEX).updateSettings(resolveIndexSettings()).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS })
    await verifyLiveEmbedder()
    searchReady = true
    log.info(`Search index already populated (${populatedDocCount} docs); skipping startup rebuild`)
    return
  }

  await rebuildSearchIndex()
  if (!searchReady) {
    // rebuildSearchIndex swallows its own errors and just leaves
    // searchReady at its prior value. Surface that as a thrown error so
    // the startup retry loop in server/index.ts can back off and try
    // again instead of declaring success against an unbuilt index.
    throw new Error('Search index rebuild did not complete')
  }
}

/**
 * Compare the live production index's embedder settings against the
 * current managed configuration (secrets stripped). Called at startup on
 * the populated path. A mismatch — for example an embedder manually
 * swapped by another tool, or a previous rebuild that never completed —
 * marks semantic search unavailable while keyword search keeps working.
 */
async function verifyLiveEmbedder(): Promise<void> {
  try {
    const client = getSearchClient()
    const settings = await client.index(ARTICLES_INDEX).getSettings()
    liveEmbedderVerified = matchesExpectedEmbedder(
      (settings.embedders as Record<string, unknown> | undefined) ?? null,
      getEmbeddingConfig(),
    )
    statsCache = null
  } catch (err) {
    log.warn('Failed to verify embedder settings on the live index:', err)
    liveEmbedderVerified = false
  }
}

/**
 * Kick off a rebuild without awaiting it. Used by the settings API when
 * embedding configuration changes; the existing `rebuilding` guard
 * prevents duplicate concurrent rebuilds.
 */
export function requestSearchRebuild(): void {
  void rebuildSearchIndex()
}

export function isRebuilding(): boolean {
  return rebuilding
}

export interface SearchIndexRuntime {
  semanticReady: boolean
  rebuilding: boolean
  lastRebuild: { startedAt: number; finishedAt: number | null; ok: boolean | null; error: string | null; documents: number | null } | null
  index: { documents: number | null; embeddedDocuments: number | null; embeddings: number | null } | null
}

/**
 * Runtime diagnostics for the settings API. Index stats come from
 * Meilisearch with a short TTL cache; any failure returns nulls rather
 * than throwing.
 */
export async function getSearchIndexRuntime(): Promise<SearchIndexRuntime> {
  let indexStats: SearchIndexRuntime['index'] = null
  if (searchReady) {
    try {
      if (!statsCache || Date.now() - statsCache.fetchedAt > STATS_CACHE_TTL_MS) {
        const stats = await getSearchClient().index(ARTICLES_INDEX).getStats()
        statsCache = {
          documents: stats.numberOfDocuments,
          embeddedDocuments: stats.numberOfEmbeddedDocuments ?? 0,
          embeddings: stats.numberOfEmbeddings ?? 0,
          fetchedAt: Date.now(),
        }
      }
      indexStats = {
        documents: statsCache.documents,
        embeddedDocuments: statsCache.embeddedDocuments,
        embeddings: statsCache.embeddings,
      }
    } catch (err) {
      log.warn('Failed to read index stats:', err)
    }
  }
  return {
    semanticReady: isSemanticReady(),
    rebuilding,
    lastRebuild: lastRebuild ? { ...lastRebuild } : null,
    index: indexStats,
  }
}

// --- Fire-and-forget sync helpers ---

export function syncArticleToSearch(doc: MeiliArticleDoc): void {
  try {
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.addDocuments([doc]).catch((err) => {
      log.error('Failed to sync article:', err)
    })

    if (changeLog) {
      changeLog.push({ action: 'upsert', id: doc.id, doc })
    }
  } catch (err) {
    log.error('Failed to sync article:', err)
  }
}

export function deleteArticleFromSearch(id: number): void {
  try {
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.deleteDocument(id).catch((err) => {
      log.error('Failed to delete article from index:', err)
    })

    if (changeLog) {
      changeLog.push({ action: 'delete', id })
    }
  } catch (err) {
    log.error('Failed to delete article from index:', err)
  }
}

export function syncArticleScoreToSearch(id: number, score: number): void {
  try {
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.updateDocuments([{ id, score }]).catch((err) => {
      log.error('Failed to sync score:', err)
    })
  } catch (err) {
    log.error('Failed to sync score:', err)
  }
}

export function syncArticleFiltersToSearch(updates: { id: number; is_unread?: boolean; is_liked?: boolean; is_bookmarked?: boolean }[]): void {
  if (updates.length === 0) return
  try {
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.updateDocuments(updates).catch((err) => {
      log.error('Failed to sync article filters:', err)
    })
  } catch (err) {
    log.error('Failed to sync article filters:', err)
  }
}

export function deleteArticlesFromSearch(articleIds: number[]): void {
  if (articleIds.length === 0) return
  try {
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.deleteDocuments({ filter: `id IN [${articleIds.join(',')}]` }).catch((err) => {
      log.error('Failed to batch delete articles:', err)
    })

    if (changeLog) {
      for (const id of articleIds) {
        changeLog.push({ action: 'delete', id })
      }
    }
  } catch (err) {
    log.error('Failed to batch delete articles:', err)
  }
}

/**
 * Bulk-sync scores for all articles that have engagement or a non-zero score.
 * Uses the shared SCORED_ARTICLES_WHERE clause from server/db/articles.ts.
 * Called after the daily score recalculation batch to keep Meilisearch in sync.
 * Skips if an index rebuild is in progress (the rebuild will include fresh scores).
 */
export async function syncAllScoredArticlesToSearch(): Promise<number> {
  if (rebuilding) {
    log.info('Index rebuild in progress, skipping score sync')
    return 0
  }

  const rows = getDb().prepare(`
    SELECT id, score FROM active_articles
    WHERE ${SCORED_ARTICLES_WHERE}
  `).all() as { id: number; score: number }[]

  if (rows.length === 0) return 0

  const client = getSearchClient()
  const index = client.index(ARTICLES_INDEX)

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    await index.updateDocuments(batch.map(({ id, score }) => ({ id, score }))).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS })
  }

  return rows.length
}

export function syncArticlesByFeedToSearch(docs: MeiliArticleDoc[]): void {
  if (docs.length === 0) return
  try {
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.addDocuments(docs).catch((err) => {
      log.error('Failed to batch sync articles:', err)
    })

    if (changeLog) {
      for (const doc of docs) {
        changeLog.push({ action: 'upsert', id: doc.id, doc })
      }
    }
  } catch (err) {
    log.error('Failed to batch sync articles:', err)
  }
}