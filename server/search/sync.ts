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
import { getEmbeddingProxyToken } from './proxy-config.js'

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
let previousEmbeddingPrerequisite: boolean | null = null
let pendingEmbeddingReconciliation = false

interface RebuildRecord {
  startedAt: number
  finishedAt: number | null
  ok: boolean | null
  error: string | null
  documents: number | null
  processedDocuments: number
  totalDocuments: number | null
}

let lastRebuild: RebuildRecord | null = null

// Bounded automatic retries for an indeterminate swap (the swap was enqueued
// but its completion is unknown). After exhaustion the loop stops, the
// reconciliation state is preserved, and a manual rebuild is required.
const MAX_INDETERMINATE_SWAP_RETRIES = 3
const SWAP_RETRY_BASE_DELAY_MS = 5_000
const SWAP_RETRY_MAX_DELAY_MS = 60_000
let swapRetriesRemaining = MAX_INDETERMINATE_SWAP_RETRIES
let swapRetryContinuation = false
let swapRetryTimer: ReturnType<typeof setTimeout> | null = null
let swapRetryDelayOverride: number | null = null
let swapPossiblyInFlight = false

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
export function reconcileEmbeddingPrerequisite(previousMet: boolean): void {
  const prerequisiteMet = isEmbeddingPrerequisiteMet()
  previousEmbeddingPrerequisite = prerequisiteMet
  if (getEmbeddingConfig().enabled && previousMet !== prerequisiteMet) {
    liveEmbedderVerified = false
    if (rebuilding) pendingEmbeddingReconciliation = true
    else requestSearchRebuild()
  }
}

export function isSemanticReady(): boolean {
  const config = getEmbeddingConfig()
  const prerequisiteMet = isEmbeddingPrerequisiteMet()
  if (previousEmbeddingPrerequisite === false && prerequisiteMet && config.enabled) {
    liveEmbedderVerified = false
    if (rebuilding) pendingEmbeddingReconciliation = true
    else requestSearchRebuild()
  }
  previousEmbeddingPrerequisite = prerequisiteMet
  if (!config.enabled || !config.provider || !config.model) return false
  if (!prerequisiteMet) return false
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
  previousEmbeddingPrerequisite = null
  pendingEmbeddingReconciliation = false
  pendingChangeLog = null
  swapRetriesRemaining = MAX_INDETERMINATE_SWAP_RETRIES
  swapRetryContinuation = false
  swapPossiblyInFlight = false
  if (swapRetryTimer) {
    clearTimeout(swapRetryTimer)
    swapRetryTimer = null
  }
}

/** @internal Test-only helper to pin the indeterminate-swap retry backoff */
export function _setSwapRetryDelay(ms: number | null): void {
  swapRetryDelayOverride = ms
}

// --- Change log for rebuild consistency ---

type FilterUpdate = { id: number; is_unread?: boolean; is_liked?: boolean; is_bookmarked?: boolean }

type ChangeEntry =
  | { action: 'upsert'; id: number; doc: MeiliArticleDoc }
  | { action: 'delete'; id: number }
  | { action: 'score'; id: number; score: number }
  | { action: 'filters'; update: FilterUpdate }

let changeLog: ChangeEntry[] | null = null
let pendingChangeLog: ChangeEntry[] | null = null

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

interface TaskLike {
  status?: string
  uid?: number
  error?: { message?: string } | null
}

/**
 * waitForTask resolves (rather than throws) when the enqueued task itself
 * fails, so every lifecycle task must have its final status checked before
 * the rebuild may proceed to the next step (or promote the staging index).
 */
class TaskFailedError extends Error {}

function assertTaskOk(task: TaskLike | null | undefined, what: string): void {
  if (task && task.status === 'failed') {
    const message = task.error?.message || `task ${task.uid ?? ''} failed`
    throw new TaskFailedError(`Meilisearch ${what} failed: ${message}`)
  }
}

function redactSecrets(message: string, secrets: (string | null | undefined)[]): string {
  return secrets.reduce<string>((safe, secret) => (secret ? safe.split(secret).join('[redacted]') : safe), message)
}

function rebuildErrorSecrets(config: { apiKey?: string | null }, embedderPlanned: boolean): (string | null | undefined)[] {
  if (!embedderPlanned) return [config.apiKey]
  const token = getEmbeddingProxyToken()
  return [config.apiKey, token, encodeURIComponent(token)]
}

function scheduleIndeterminateSwapRetry(delay: number): void {
  swapRetryTimer = setTimeout(() => {
    swapRetryTimer = null
    if (rebuilding) {
      // A concurrent rebuild is running; retry shortly instead of dropping
      // the pending reconciliation.
      scheduleIndeterminateSwapRetry(1_000)
      return
    }
    swapRetryContinuation = true
    void rebuildSearchIndex()
    swapRetryContinuation = false
  }, delay)
}

/**
 * Bounded retries are exhausted while the swap's completion is still
 * unknown: stop the automatic loop, keep whichever production index is live
 * available for keyword search when it holds documents, resolve semantic
 * readiness against the live settings, and surface a manual-rebuild error.
 */
async function recoverAfterSwapRetryExhaustion(): Promise<void> {
  const message = `${lastRebuild?.error ?? 'Index swap indeterminate'}; index swap stayed indeterminate after ${MAX_INDETERMINATE_SWAP_RETRIES} automatic retries — resolve the Meilisearch issue and trigger a manual rebuild`
  try {
    const stats = await getSearchClient().index(ARTICLES_INDEX).getStats()
    await verifyLiveEmbedder()
    if (stats.numberOfDocuments > 0) {
      searchReady = true
      log.error(`${message}; keyword search remains available on the live index`)
    } else {
      log.error(message)
    }
  } catch (err) {
    log.error(message, err)
  }
  if (lastRebuild) {
    lastRebuild = { ...lastRebuild, error: message }
  }
}

export async function rebuildSearchIndex(): Promise<void> {
  if (rebuilding) {
    log.info('Rebuild already in progress, skipping')
    return
  }
  if (swapRetryContinuation) {
    swapRetryContinuation = false
  } else {
    // Any explicitly triggered rebuild (config change, manual retry, cron)
    // restarts the bounded-retry budget.
    swapRetriesRemaining = MAX_INDETERMINATE_SWAP_RETRIES
    if (swapRetryTimer) {
      clearTimeout(swapRetryTimer)
      swapRetryTimer = null
    }
  }
  rebuilding = true
  liveEmbedderVerified = false
  const priorSwapInFlight = swapPossiblyInFlight
  changeLog = pendingChangeLog ?? changeLog ?? []
  pendingChangeLog = null
  const config = getEmbeddingConfig()
  const prerequisiteMet = isEmbeddingPrerequisiteMet()
  const embedderPlanned = !!buildEmbeddersSettings(config) && prerequisiteMet
  const settings = embedderPlanned ? resolveIndexSettings(config) : { ...INDEX_SETTINGS }
  lastRebuild = {
    startedAt: Date.now(),
    finishedAt: null,
    ok: null,
    error: null,
    documents: null,
    processedDocuments: 0,
    totalDocuments: null,
  }

  let productionSwapped = false
  try {
    const client = getSearchClient()
    const startedAt = Date.now()

    // Collect existing index UIDs to avoid 404 requests
    const { results: existingIndexes } = await client.getIndexes()
    const indexSet = new Set(existingIndexes.map((idx: { uid: string }) => idx.uid))

    // 1. Create or reset staging index
    if (indexSet.has(ARTICLES_STAGING_INDEX)) {
      assertTaskOk(
        await client.deleteIndex(ARTICLES_STAGING_INDEX).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS }),
        'staging index cleanup',
      )
    }
    assertTaskOk(
      await client.createIndex(ARTICLES_STAGING_INDEX, { primaryKey: 'id' }).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS }),
      'staging index creation',
    )

    // 2. Apply index settings (including the managed embedder) to staging
    const stagingIndex = client.index(ARTICLES_STAGING_INDEX)
    assertTaskOk(
      await stagingIndex.updateSettings(settings).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS }),
      'staging settings update',
    )

    // 3. Fetch all articles from SQLite and batch-insert into staging
    const rows = getDb().prepare(`
      SELECT a.id, a.feed_id, a.category_id, a.title,
             a.summary,
             f.type AS feed_type,
             COALESCE(a.full_text, '') AS full_text,
             COALESCE(a.full_text_translated, '') AS full_text_translated,
             a.lang,
             COALESCE(CAST(strftime('%s', a.published_at) AS INTEGER), 0) AS published_at,
             COALESCE(a.score, 0) AS score,
             (a.seen_at IS NULL) AS is_unread,
             (a.liked_at IS NOT NULL) AS is_liked,
             (a.bookmarked_at IS NOT NULL) AS is_bookmarked
      FROM active_articles a
      JOIN feeds f ON f.id = a.feed_id
    `).all() as MeiliArticleDoc[]

    // SQLite returns 0/1 for boolean expressions; Meilisearch needs true/false
    const docs = rows.map((row) => applyEmbeddingVectors({
      ...row,
      is_unread: Boolean(row.is_unread),
      is_liked: Boolean(row.is_liked),
      is_bookmarked: Boolean(row.is_bookmarked),
    }, config, prerequisiteMet))
    lastRebuild = { ...lastRebuild!, totalDocuments: docs.length }

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE)
      // A failed document task with an embedder configured means embedding
      // generation is broken (bad credential, provider outage, dimension
      // mismatch). Abort before the swap so the previous production index
      // stays usable for both keyword and semantic search instead of
      // promoting an index that was never built.
      assertTaskOk(
        await stagingIndex.addDocuments(batch).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS }),
        'document indexing',
      )
      lastRebuild = { ...lastRebuild!, processedDocuments: Math.min(i + batch.length, docs.length) }
    }

    // 4. Promote staging to production
    if (!indexSet.has(ARTICLES_INDEX)) {
      // First run: no existing articles index — create empty one for swap
      assertTaskOk(
        await client.createIndex(ARTICLES_INDEX, { primaryKey: 'id' }).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS }),
        'production index creation',
      )
    }
    // Swap articles <-> articles_staging, then clean up old data. The swap is
    // committed server-side as soon as it is enqueued, so mark it in-flight
    // BEFORE waiting: if waitTask times out under queue pressure the swap
    // may still complete later, and the change log must be preserved for a
    // reconciliation rerun instead of being discarded.
    const swapTask = client.swapIndexes([
      { indexes: [ARTICLES_INDEX, ARTICLES_STAGING_INDEX] } as any,
    ])
    productionSwapped = true
    swapPossiblyInFlight = true
    try {
      assertTaskOk(await swapTask.waitTask({ timeout: MEILI_TASK_TIMEOUT_MS }), 'staging swap')
      swapPossiblyInFlight = false
    } catch (err) {
      // A swap task that determinately failed was never committed (the task
      // is atomic), so the previous production index is intact and needs no
      // reconciliation: only a timeout/transport error is indeterminate.
      if (err instanceof TaskFailedError) {
        productionSwapped = false
        swapPossiblyInFlight = false
      }
      throw err
    }
    assertTaskOk(
      await client.deleteIndex(ARTICLES_STAGING_INDEX).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS }),
      'staging index cleanup',
    )

    liveEmbedderVerified = embedderPlanned ? await verifyLiveEmbedder() : false

    // 5. Replay change log. Entries are submitted in batches of consecutive
    // same-action runs: a rebuild overlapping the score recalculation cron
    // can capture thousands of score entries, and one awaited task per entry
    // would keep `rebuilding` set and search unready for hours.
    if (changeLog && changeLog.length > 0) {
      const prodIndex = client.index(ARTICLES_INDEX)
      let i = 0
      while (i < changeLog.length) {
        const action = changeLog[i].action
        let end = i
        while (end < changeLog.length && changeLog[end].action === action) end++
        const run = changeLog.slice(i, end)
        i = end
        if (action === 'upsert') {
          for (let b = 0; b < run.length; b += BATCH_SIZE) {
            const batch = run.slice(b, b + BATCH_SIZE).map(e => (e as Extract<ChangeEntry, { action: 'upsert' }>).doc)
            assertTaskOk(
              await prodIndex.addDocuments(batch).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS }),
              'replay document indexing',
            )
          }
        } else if (action === 'delete') {
          for (let b = 0; b < run.length; b += BATCH_SIZE) {
            const ids = run.slice(b, b + BATCH_SIZE).map(e => (e as Extract<ChangeEntry, { action: 'delete' }>).id)
            assertTaskOk(
              await prodIndex.deleteDocuments(ids).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS }),
              'replay deletion',
            )
          }
        } else {
          for (let b = 0; b < run.length; b += BATCH_SIZE) {
            const batch = run.slice(b, b + BATCH_SIZE).map(e =>
              e.action === 'score'
                ? { id: (e as Extract<ChangeEntry, { action: 'score' }>).id, score: (e as Extract<ChangeEntry, { action: 'score' }>).score }
                : (e as Extract<ChangeEntry, { action: 'filters' }>).update,
            )
            assertTaskOk(
              await prodIndex.updateDocuments(batch).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS }),
              'replay document update',
            )
          }
        }
      }
    }

    searchReady = true
    swapRetriesRemaining = MAX_INDETERMINATE_SWAP_RETRIES
    if (swapRetryTimer) {
      clearTimeout(swapRetryTimer)
      swapRetryTimer = null
    }
    lastRebuild = {
      ...lastRebuild!,
      finishedAt: Date.now(),
      ok: true,
      error: null,
      documents: docs.length,
      processedDocuments: docs.length,
      totalDocuments: docs.length,
    }
    statsCache = null
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    log.info(`Index rebuild complete: ${docs.length} articles in ${elapsed}s${embedderPlanned ? ' (embeddings enabled)' : ''}`)
  } catch (err) {
    if (productionSwapped && !swapPossiblyInFlight) {
      // The swap task determinately committed: production already holds the
      // complete fresh snapshot, so a post-swap failure (staging cleanup,
      // partially failed replay) must not run the indeterminate-swap
      // reconciliation. Keep search available on the committed snapshot and
      // only preserve a non-empty change log (a replay that failed mid-way
      // still needs its mutations replayed by the bounded retry).
      searchReady = true
      if (changeLog && changeLog.length > 0) {
        pendingChangeLog = [...changeLog]
      }
    } else if (productionSwapped) {
      searchReady = false
      liveEmbedderVerified = false
      pendingChangeLog = changeLog ? [...changeLog] : []
    } else if ((swapPossiblyInFlight || priorSwapInFlight) && changeLog && changeLog.length > 0) {
      // An earlier swap may have committed (or may still commit) and promote
      // a snapshot that omits the captured mutations; preserve them so the
      // bounded retry reconciles. When the earlier swap already committed
      // FIFO, the live production index is the pre-swap known-good one only
      // in the still-in-flight case, so keyword search stays available.
      pendingChangeLog = [...changeLog]
    }
    const rawMessage = err instanceof Error ? err.message : String(err)
    const message = redactSecrets(rawMessage, rebuildErrorSecrets(config, embedderPlanned))
    log.error('Index rebuild failed:', message)
    lastRebuild = {
      startedAt: lastRebuild?.startedAt ?? Date.now(),
      finishedAt: Date.now(),
      ok: false,
      error: message,
      documents: lastRebuild?.documents ?? null,
      processedDocuments: lastRebuild?.processedDocuments ?? 0,
      totalDocuments: lastRebuild?.totalDocuments ?? null,
    }
  } finally {
    rebuilding = false
    const swapIndeterminate = pendingChangeLog !== null
    if (swapIndeterminate && swapRetriesRemaining > 0) {
      // The enqueued swap may still complete; rerun reconciliation after a
      // capped exponential backoff instead of hot-looping full rebuilds.
      // Keep capturing into the preserved log while the retry is pending and
      // carry it into the retry's change log so no captured mutation is lost
      // even if this retry is superseded by another rebuild.
      pendingEmbeddingReconciliation = false
      const attempt = MAX_INDETERMINATE_SWAP_RETRIES - swapRetriesRemaining + 1
      swapRetriesRemaining--
      const delay = swapRetryDelayOverride ?? Math.min(
        SWAP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        SWAP_RETRY_MAX_DELAY_MS,
      )
      log.warn(`Index swap indeterminate; scheduling automatic retry ${attempt}/${MAX_INDETERMINATE_SWAP_RETRIES} in ${delay}ms`)
      changeLog = pendingChangeLog
      pendingChangeLog = null
      scheduleIndeterminateSwapRetry(delay)
    } else if (swapIndeterminate) {
      changeLog = null
      await recoverAfterSwapRetryExhaustion()
    } else {
      changeLog = null
    }
    const reconcile = pendingEmbeddingReconciliation && getEmbeddingConfig().enabled && isEmbeddingPrerequisiteMet()
    pendingEmbeddingReconciliation = false
    if (reconcile) requestSearchRebuild()
  }
}

/**
 * Idempotent startup hook for search. Inspects the Meilisearch state and
 * triggers a full `rebuildSearchIndex()` if the articles index is missing or
 * empty. For a populated index, it reapplies settings and checks database
 * document/vector coverage before deciding whether a repair rebuild is needed.
 *
 * This avoids the race that happens when each restart fires a fresh
 * rebuild while the previous process's index-management tasks are still
 * in the Meilisearch queue (the symptom is "Index `articles_staging`
 * already exists" failures and waitTask timeouts piling up). A needed repair
 * is still guarded by the same rebuild flag.
 *
 * The 6-hour cron continues to call `rebuildSearchIndex()` directly so a
 * full refresh still happens periodically.
 */
function getExpectedSearchCoverage(): { documents: number; embeddedDocuments: number } | null {
  try {
    const row = getDb().prepare(`
      SELECT
        COUNT(*) AS documents,
        COUNT(CASE WHEN a.summary IS NOT NULL AND trim(a.summary) != '' AND f.type != 'clip' THEN 1 END) AS embeddedDocuments
      FROM active_articles a
      JOIN feeds f ON f.id = a.feed_id
    `).get() as { documents: number; embeddedDocuments: number }
    return row
  } catch (err) {
    log.warn('Failed to inspect database search coverage:', err)
    return null
  }
}

function hasIncompleteSearchCoverage(
  stats: { numberOfDocuments: number; numberOfEmbeddedDocuments?: number; numberOfEmbeddings?: number },
  expected: { documents: number; embeddedDocuments: number },
): boolean {
  const embeddedDocuments = stats.numberOfEmbeddedDocuments ?? 0
  const embeddings = stats.numberOfEmbeddings ?? embeddedDocuments
  return stats.numberOfDocuments !== expected.documents || embeddedDocuments !== expected.embeddedDocuments || embeddings !== expected.embeddedDocuments
}

export async function ensureSearchIndex(): Promise<void> {
  // Step 1: existence and population check. Failures here usually mean
  // Meilisearch is unreachable, so we want to fall through to the rebuild
  // path so the startup retry loop can confirm whether Meili is back.
  let populatedDocCount = 0
  let populatedStats: { numberOfDocuments: number; numberOfEmbeddedDocuments?: number; numberOfEmbeddings?: number } | null = null
  try {
    const client = getSearchClient()
    const { results: existingIndexes } = await client.getIndexes()
    const articles = existingIndexes.find((idx: { uid: string }) => idx.uid === ARTICLES_INDEX)
    if (articles) {
      const stats = await client.index(ARTICLES_INDEX).getStats()
      populatedStats = stats
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
    const config = getEmbeddingConfig()
    const embedderPlanned = !!buildEmbeddersSettings(config) && isEmbeddingPrerequisiteMet()
    const startupEmbedders = embedderPlanned ? buildEmbeddersSettings(config) : {}
    try {
      assertTaskOk(
        await client.index(ARTICLES_INDEX).updateSettings({
          ...resolveIndexSettings(config),
          embedders: startupEmbedders,
        }).waitTask({ timeout: MEILI_TASK_TIMEOUT_MS }),
        'production settings update',
      )
    } catch (err) {
      // A rejected settings task fails deterministically (e.g. an invalid
      // embedder model/dimensions combination that the PATCH API accepted):
      // retrying cannot recover. The production index itself is intact, so
      // keep keyword search available, mark semantic search unavailable, and
      // surface the error through the rebuild record shown in the settings
      // API instead of letting startup retries 503 all search.
      if (!(err instanceof TaskFailedError)) throw err
      const message = redactSecrets(err.message, rebuildErrorSecrets(config, embedderPlanned))
      log.error('Production settings update failed; search degrades to keyword-only:', message)
      searchReady = true
      liveEmbedderVerified = false
      lastRebuild = {
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ok: false,
        error: message,
        documents: populatedDocCount,
        processedDocuments: 0,
        totalDocuments: populatedDocCount,
      }
      return
    }
    const liveEmbedderMatches = await verifyLiveEmbedder()
    searchReady = true
    const expectedCoverage = getExpectedSearchCoverage()
    const needsEmbeddingRepair = embedderPlanned && (
      !liveEmbedderMatches ||
      !expectedCoverage ||
      !populatedStats ||
      hasIncompleteSearchCoverage(populatedStats, expectedCoverage)
    )
    if (needsEmbeddingRepair) {
      liveEmbedderVerified = false
      requestSearchRebuild()
      log.warn('Search index embedding coverage is incomplete; scheduled a repair rebuild')
    }

    log.info(`Search index already populated (${populatedDocCount} docs); skipping full startup rebuild`)
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
async function verifyLiveEmbedder(): Promise<boolean> {
  try {
    const client = getSearchClient()
    const settings = await client.index(ARTICLES_INDEX).getSettings()
    liveEmbedderVerified = matchesExpectedEmbedder(
      (settings.embedders as Record<string, unknown> | undefined) ?? null,
      getEmbeddingConfig(),
    )
    statsCache = null
    return liveEmbedderVerified
  } catch (err) {
    log.warn('Failed to verify embedder settings on the live index:', err)
    liveEmbedderVerified = false
    return false
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
  lastRebuild: { startedAt: number; finishedAt: number | null; ok: boolean | null; error: string | null; documents: number | null; processedDocuments: number; totalDocuments: number | null } | null
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
  const config = getEmbeddingConfig()
  const embeddingDoc = applyEmbeddingVectors(doc, config)
  try {
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.addDocuments([embeddingDoc]).catch((err) => {
      log.error('Failed to sync article:', err)
    })

    if (changeLog) {
      changeLog.push({ action: 'upsert', id: embeddingDoc.id, doc: embeddingDoc })
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

    if (changeLog) {
      changeLog.push({ action: 'score', id, score })
    }
  } catch (err) {
    log.error('Failed to sync score:', err)
  }
}

export function syncArticleFiltersToSearch(updates: FilterUpdate[]): void {
  if (updates.length === 0) return
  try {
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.updateDocuments(updates).catch((err) => {
      log.error('Failed to sync article filters:', err)
    })

    if (changeLog) {
      for (const update of updates) {
        changeLog.push({ action: 'filters', update: { ...update } })
      }
    }
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
 * Captures current scores for replay when an index rebuild is in progress.
 */
export async function syncAllScoredArticlesToSearch(): Promise<number> {
  const rows = getDb().prepare(`
    SELECT id, score FROM active_articles
    WHERE ${SCORED_ARTICLES_WHERE}
  `).all() as { id: number; score: number }[]

  if (rebuilding || changeLog) {
    if (changeLog) {
      for (const row of rows) changeLog.push({ action: 'score', id: row.id, score: row.score })
    }
    log.info('Index rebuild in progress, captured score sync')
    return 0
  }

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
  const config = getEmbeddingConfig()
  const embeddingDocs = docs.map((doc) => applyEmbeddingVectors(doc, config))
  try {
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.addDocuments(embeddingDocs).catch((err) => {
      log.error('Failed to batch sync articles:', err)
    })

    if (changeLog) {
      for (const doc of embeddingDocs) {
        changeLog.push({ action: 'upsert', id: doc.id, doc })
      }
    }
  } catch (err) {
    log.error('Failed to batch sync articles:', err)
  }
}