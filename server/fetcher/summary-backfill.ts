import { getSetting } from '../db.js'
import { getSummaryCounts, getArticlesMissingSummaries } from '../db.js'
import { autoSummarizeArticle, shouldAutoSummarizeNow } from './ai.js'
import { getSummaryConcurrency } from './summary-concurrency.js'
import { logger } from '../logger.js'

const log = logger.child('summary-backfill')

/**
 * Hard cap on articles processed per backfill run, so a huge backlog cannot
 * pin the summarizer forever — the user can simply press "continue" again.
 */
const MAX_ARTICLES_PER_RUN = 1000

export interface SummaryBackfillState {
  running: boolean
  startedAt: number | null
  /** Articles attempted in the current (or last) run. */
  processed: number
  /** Articles that got a summary during the current (or last) run. */
  summarized: number
  /** Articles whose summarization failed or was skipped in the last run. */
  failed: number
  /** Articles still pending in the current run (0 when idle). */
  queueRemaining: number
}

let state: SummaryBackfillState = {
  running: false,
  startedAt: null,
  processed: 0,
  summarized: 0,
  failed: 0,
  queueRemaining: 0,
}

let inFlight: Promise<void> | null = null

export function getSummaryBackfillState(): Readonly<SummaryBackfillState> {
  return state
}

/**
 * Coverage snapshot for the settings UI. Pure DB reads plus the backfill
 * job's runtime state — safe to call (and useful) even when no summary
 * provider is configured.
 */
export function getSummaryStatus() {
  const counts = getSummaryCounts()
  return {
    total: counts.total,
    summarized: counts.summarized,
    missing: counts.total - counts.summarized,
    backfillRunning: state.running,
    backfillQueue: state.running ? state.queueRemaining : 0,
    backfillProcessed: state.processed,
  }
}

export type StartSummaryBackfillResult =
  | { started: true }
  | { started: false; reason: 'already-running' | 'not-configured' | 'nothing-to-do' }

/**
 * Kick off a single-flight background job that walks articles with empty
 * summaries (bounded batches) and summarizes them through the shared
 * concurrency limiter. Idempotent: a no-op with a clear reason when a run
 * is already active, when no summary provider is configured (or the auto
 * toggle is off), or when there is nothing left to summarize.
 */
export function startSummaryBackfill(): StartSummaryBackfillResult {
  if (state.running || inFlight) return { started: false, reason: 'already-running' }
  if (!shouldAutoSummarizeNow()) return { started: false, reason: 'not-configured' }
  const { total, summarized } = getSummaryCounts()
  const missing = total - summarized
  if (missing <= 0) return { started: false, reason: 'nothing-to-do' }

  state = {
    running: true,
    startedAt: Date.now(),
    processed: 0,
    summarized: 0,
    failed: 0,
    queueRemaining: missing,
  }
  inFlight = runBackfill(missing)
    .catch(err => {
      log.error({ err }, 'summary backfill crashed')
    })
    .finally(() => {
      state = { ...state, running: false, queueRemaining: 0 }
      inFlight = null
    })
  return { started: true }
}

/** Resolves when no backfill run is active. Exposed for tests. */
export function whenSummaryBackfillSettles(): Promise<void> {
  return inFlight ?? Promise.resolve()
}

/**
 * Reset module state between tests. Only safe when no run is active.
 */
export function resetSummaryBackfillForTests(): void {
  state = {
    running: false,
    startedAt: null,
    processed: 0,
    summarized: 0,
    failed: 0,
    queueRemaining: 0,
  }
  inFlight = null
}

async function runBackfill(initialMissing: number): Promise<void> {
  let processed = 0
  let summarized = 0
  let failed = 0
  // Articles already attempted this run; retried failures would otherwise
  // be picked up again by the next batch query and loop forever.
  const attempted = new Set<number>()

  try {
    while (processed < MAX_ARTICLES_PER_RUN) {
      // Respect the auto-summarization gating: a mid-run toggle-off or
      // provider removal stops the job on the next batch boundary.
      if (!shouldAutoSummarizeNow()) {
        log.info('summary backfill stopped: automatic summarization no longer active')
        break
      }
      const batchSize = getSummaryConcurrency(getSetting)
      const batch = getArticlesMissingSummaries(batchSize, [...attempted])
      if (batch.length === 0) break

      // The shared limiter (see summary-concurrency.ts) enforces the real
      // parallelism cap across ingestion and backfill; the batch size just
      // bounds how much work is staged at once.
      const results = await Promise.all(
        batch.map(article => {
          attempted.add(article.id)
          return autoSummarizeArticle(article.id, article.full_text ?? '')
        }),
      )

      processed += results.length
      const ok = results.filter(Boolean).length
      summarized += ok
      failed += results.length - ok
      state = {
        ...state,
        processed,
        summarized,
        failed,
        queueRemaining: Math.max(initialMissing - processed, 0),
      }

      // No progress in a whole batch means every call failed or was
      // skipped (e.g. provider errors) — stop instead of spinning.
      if (ok === 0) {
        log.warn({ failed: results.length }, 'summary backfill stopped: batch made no progress')
        break
      }
    }
  } finally {
    log.info({ processed, summarized, failed }, 'summary backfill finished')
  }
}
