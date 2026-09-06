import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — the backfill must be tested against the real DB but with
// a controllable summarizer + gating function.
// ---------------------------------------------------------------------------

const { mockAutoSummarize, mockShouldAutoSummarize } = vi.hoisted(() => ({
  mockAutoSummarize: vi.fn<(articleId: number, fullText: string) => Promise<boolean>>(),
  mockShouldAutoSummarize: vi.fn<() => boolean>(),
}))

vi.mock('./ai.js', () => ({
  autoSummarizeArticle: (articleId: number, fullText: string) => mockAutoSummarize(articleId, fullText),
  shouldAutoSummarizeNow: () => mockShouldAutoSummarize(),
}))

import { setupTestDb } from '../__tests__/helpers/testDb.js'
import { createFeed, insertArticle, getDb, upsertSetting, updateArticleContent } from '../db.js'
import {
  getSummaryStatus,
  startSummaryBackfill,
  whenSummaryBackfillSettles,
  resetSummaryBackfillForTests,
  getSummaryBackfillState,
} from './summary-backfill.js'

function seedFeed(type: 'rss' | 'clip' = 'rss'): number {
  return createFeed({ name: `feed-${Math.random()}`, url: `http://example.com/${Math.random()}`, type }).id
}

function seedArticle(feedId: number, opts: { summary?: string | null; fullText?: string | null } = {}): number {
  const url = `http://example.com/a-${Math.random()}`
  return insertArticle({
    feed_id: feedId,
    title: 't',
    url,
    published_at: null,
    full_text: opts.fullText !== undefined ? opts.fullText : 'Full body text',
    summary: opts.summary ?? null,
  })
}

beforeEach(() => {
  setupTestDb()
  resetSummaryBackfillForTests()
  mockAutoSummarize.mockReset()
  mockShouldAutoSummarize.mockReset()
  mockShouldAutoSummarize.mockReturnValue(true)
  // Default: a successful summarization that actually persists the summary,
  // mirroring what the real autoSummarizeArticle does via updateArticleContent.
  mockAutoSummarize.mockImplementation(async (articleId: number) => {
    await new Promise(resolve => setTimeout(resolve, 1))
    updateArticleContent(articleId, { summary: `summary-${articleId}` })
    return true
  })
  upsertSetting('summary.concurrency', '4')
})

afterEach(async () => {
  await whenSummaryBackfillSettles()
})

describe('summary counts (getSummaryStatus)', () => {
  it('counts summarized vs missing over summarizable articles only', () => {
    const feed = seedFeed('rss')
    const clipFeed = seedFeed('clip')

    seedArticle(feed, { summary: 'A summary' })                       // summarized
    seedArticle(feed, { summary: '   ' })                              // blank summary = missing
    seedArticle(feed, {})                                              // missing
    seedArticle(feed, { fullText: null })                              // no full text → not counted
    seedArticle(clipFeed, {})                                          // clip feed → not counted
    seedArticle(feed, { summary: 'Another' })                          // summarized

    const status = getSummaryStatus()
    expect(status.total).toBe(4)
    expect(status.summarized).toBe(2)
    expect(status.missing).toBe(2)
    expect(status.backfillRunning).toBe(false)
    expect(status.backfillQueue).toBe(0)
  })

  it('excludes purged articles', () => {
    const feed = seedFeed('rss')
    const id = seedArticle(feed, {})
    getDb().prepare('UPDATE articles SET purged_at = datetime(\'now\') WHERE id = ?').run(id)
    expect(getSummaryStatus().total).toBe(0)
  })

  it('reports zeros on an empty database', () => {
    expect(getSummaryStatus()).toMatchObject({ total: 0, summarized: 0, missing: 0 })
  })
})

describe('startSummaryBackfill gating', () => {
  it('is a no-op when automatic summarization is not active (no provider)', async () => {
    seedFeed('rss')
    seedArticle(seedFeed('rss'), {})
    mockShouldAutoSummarize.mockReturnValue(false)

    const result = startSummaryBackfill()
    expect(result).toEqual({ started: false, reason: 'not-configured' })
    expect(mockAutoSummarize).not.toHaveBeenCalled()
    expect(getSummaryStatus().backfillRunning).toBe(false)
  })

  it('is a no-op when there is nothing to summarize', () => {
    const feed = seedFeed('rss')
    seedArticle(feed, { summary: 'done' })
    const result = startSummaryBackfill()
    expect(result).toEqual({ started: false, reason: 'nothing-to-do' })
    expect(mockAutoSummarize).not.toHaveBeenCalled()
  })
})

describe('startSummaryBackfill single-flight', () => {
  it('rejects a second start while a run is active', async () => {
    const feed = seedFeed('rss')
    for (let i = 0; i < 3; i++) seedArticle(feed, {})
    // Deferred summarizations keep the run active; on release they persist
    // a summary like the real autoSummarizeArticle would.
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    mockAutoSummarize.mockImplementation(async (articleId: number) => {
      await gate
      updateArticleContent(articleId, { summary: `s-${articleId}` })
      return true
    })

    const first = startSummaryBackfill()
    expect(first).toEqual({ started: true })
    expect(getSummaryStatus().backfillRunning).toBe(true)

    const second = startSummaryBackfill()
    expect(second).toEqual({ started: false, reason: 'already-running' })
    expect(mockAutoSummarize).toHaveBeenCalledTimes(3) // all 3 staged into one batch

    release()
    await whenSummaryBackfillSettles()
    expect(getSummaryStatus().backfillRunning).toBe(false)
    expect(getSummaryStatus().summarized).toBe(3)
  })

  it('is restartable after a run completes', async () => {
    const feed = seedFeed('rss')
    seedArticle(feed, {})
    expect(startSummaryBackfill().started).toBe(true)
    await whenSummaryBackfillSettles()
    expect(getSummaryStatus().missing).toBe(0)

    // New gap appears (e.g. more articles arrived): run again.
    seedArticle(feed, {})
    expect(startSummaryBackfill().started).toBe(true)
    await whenSummaryBackfillSettles()
    expect(getSummaryStatus().missing).toBe(0)
  })
})

describe('backfill batch processing', () => {
  it('summarizes all missing articles across batches', async () => {
    const feed = seedFeed('rss')
    for (let i = 0; i < 9; i++) seedArticle(feed, {})
    upsertSetting('summary.concurrency', '4')

    expect(startSummaryBackfill().started).toBe(true)
    await whenSummaryBackfillSettles()

    expect(mockAutoSummarize).toHaveBeenCalledTimes(9)
    const st = getSummaryStatus()
    expect(st.backfillProcessed).toBe(9)
    expect(st.summarized).toBe(9)
    expect(st.missing).toBe(0)
    expect(st.backfillQueue).toBe(0)
  })

  it('reports progress via queueRemaining while running', async () => {
    const feed = seedFeed('rss')
    for (let i = 0; i < 6; i++) seedArticle(feed, {})
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    mockAutoSummarize.mockImplementation(() => gate.then(() => true))

    startSummaryBackfill()
    // First batch (4) is in flight, queue reports the remainder.
    expect(getSummaryStatus().backfillQueue).toBe(6)

    release()
    await whenSummaryBackfillSettles()
    expect(getSummaryStatus().backfillQueue).toBe(0)
  })

  it('stops when a whole batch fails (no progress), without retry-spinning', async () => {
    const feed = seedFeed('rss')
    for (let i = 0; i < 9; i++) seedArticle(feed, {})
    mockAutoSummarize.mockResolvedValue(false)

    startSummaryBackfill()
    await whenSummaryBackfillSettles()

    // One batch of 4 attempted, each exactly once.
    expect(mockAutoSummarize).toHaveBeenCalledTimes(4)
    expect(getSummaryStatus().backfillProcessed).toBe(4)
    expect(getSummaryBackfillState().failed).toBe(4)
    expect(getSummaryStatus().summarized).toBe(0)
  })

  it('does not re-attempt articles that failed earlier in the same run', async () => {
    const feed = seedFeed('rss')
    for (let i = 0; i < 6; i++) seedArticle(feed, {})
    // Odd ids succeed (and persist a summary), even ids fail; the next
    // batch must exclude the already-attempted articles.
    mockAutoSummarize.mockImplementation(async (articleId: number) => {
      if (articleId % 2 === 1) updateArticleContent(articleId, { summary: `s-${articleId}` })
      return articleId % 2 === 1
    })

    startSummaryBackfill()
    await whenSummaryBackfillSettles()

    expect(mockAutoSummarize).toHaveBeenCalledTimes(6)
    expect(getSummaryStatus().summarized).toBe(3)
  })

  it('stops mid-run when the auto-summarization gating turns off', async () => {
    const feed = seedFeed('rss')
    for (let i = 0; i < 6; i++) seedArticle(feed, {})
    mockShouldAutoSummarize.mockReturnValueOnce(true).mockReturnValue(false)

    startSummaryBackfill()
    await whenSummaryBackfillSettles()

    expect(mockAutoSummarize).not.toHaveBeenCalled()
    expect(getSummaryBackfillState().running).toBe(false)
  })

  it('picks up articles whose summaries were cleared (re-summarize)', async () => {
    const feed = seedFeed('rss')
    const id = seedArticle(feed, { summary: 'old' })
    updateArticleContent(id, { summary: '' })

    startSummaryBackfill()
    await whenSummaryBackfillSettles()
    expect(mockAutoSummarize).toHaveBeenCalledTimes(1)
  })
})
