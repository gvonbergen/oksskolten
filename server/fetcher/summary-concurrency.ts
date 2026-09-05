import { getSetting } from '../db.js'

export const SUMMARY_CONCURRENCY_DEFAULT = 4
export const SUMMARY_CONCURRENCY_MAX = 16

/**
 * Resolve the configured parallelism for summarization LLM calls from the
 * `summary.concurrency` setting. Anything unset or malformed falls back to
 * the default; values above the upper bound are clamped so a bad stored
 * value can never unleash an unbounded number of concurrent requests on
 * the LLM server.
 */
export function getSummaryConcurrency(readSetting: (key: string) => string | null | undefined = getSetting): number {
  const raw = readSetting('summary.concurrency')
  if (!raw) return SUMMARY_CONCURRENCY_DEFAULT
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return SUMMARY_CONCURRENCY_DEFAULT
  return Math.min(parsed, SUMMARY_CONCURRENCY_MAX)
}

/**
 * Semaphore whose capacity is re-read from settings on every acquire, so
 * changing the parallelism setting applies to in-flight pipelines (ingestion
 * fire-and-forget calls and the backfill job share this limiter) without a
 * restart. Waiters re-check the capacity when woken, so lowering the limit
 * mid-queue never overshoots the new cap by more than already-active work.
 */
export class DynamicSemaphore {
  private queue: (() => void)[] = []
  private active = 0

  constructor(private readonly maxCapacity: () => number) {}

  get max(): number {
    return Math.max(1, this.maxCapacity())
  }

  get activeCount(): number {
    return this.active
  }

  get queueLength(): number {
    return this.queue.length
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.max) {
      await new Promise<void>(resolve => this.queue.push(resolve))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

/** Shared limiter: at most N summarization LLM calls run at once. */
export const summaryLimiter = new DynamicSemaphore(getSummaryConcurrency)

export function runWithSummaryConcurrency<T>(fn: () => Promise<T>): Promise<T> {
  return summaryLimiter.run(fn)
}
