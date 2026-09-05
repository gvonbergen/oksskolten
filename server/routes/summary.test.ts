import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { setupTestDb } from '../__tests__/helpers/testDb.js'
import { buildApp } from '../__tests__/helpers/buildApp.js'
import { createFeed, insertArticle, upsertSetting, updateArticleContent } from '../db.js'

// The route layer only needs controllable gating + summarization; the DB is
// real so the status counts are exercised end-to-end.
const { mockAutoSummarize, mockShouldAutoSummarize } = vi.hoisted(() => ({
  mockAutoSummarize: vi.fn<(articleId: number, fullText: string) => Promise<boolean>>(),
  mockShouldAutoSummarize: vi.fn<() => boolean>(),
}))

vi.mock('../fetcher/ai.js', () => ({
  autoSummarizeArticle: (articleId: number, fullText: string) => mockAutoSummarize(articleId, fullText),
  shouldAutoSummarizeNow: () => mockShouldAutoSummarize(),
  detectLanguage: () => 'en',
  summarizeArticle: vi.fn(),
  streamSummarizeArticle: vi.fn(),
  translateArticle: vi.fn(),
  streamTranslateArticle: vi.fn(),
}))

import { resetSummaryBackfillForTests, whenSummaryBackfillSettles } from '../fetcher/summary-backfill.js'

let app: FastifyInstance

function seedMissingArticles(n: number): void {
  const feed = createFeed({ name: `f-${Math.random()}`, url: `http://example.com/${Math.random()}` })
  for (let i = 0; i < n; i++) {
    insertArticle({
      feed_id: feed.id,
      title: `t${i}`,
      url: `http://example.com/a-${Math.random()}`,
      published_at: null,
      full_text: 'body',
    })
  }
}

beforeEach(async () => {
  setupTestDb()
  resetSummaryBackfillForTests()
  mockAutoSummarize.mockReset()
  mockShouldAutoSummarize.mockReset()
  mockShouldAutoSummarize.mockReturnValue(true)
  mockAutoSummarize.mockResolvedValue(true)
  app = await buildApp()
})

afterEach(async () => {
  await app.close()
  await whenSummaryBackfillSettles()
})

describe('GET /api/settings/summary/status', () => {
  it('returns counts on an empty database (works without a provider)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/summary/status' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      total: 0,
      summarized: 0,
      missing: 0,
      backfillRunning: false,
      backfillQueue: 0,
      backfillProcessed: 0,
    })
  })

  it('counts summarized vs missing and excludes clip feeds', async () => {
    const feed = createFeed({ name: 'f', url: 'http://example.com/f' })
    const clip = createFeed({ name: 'c', url: 'http://example.com/c', type: 'clip' })
    insertArticle({ feed_id: feed.id, title: 'a', url: 'http://example.com/1', published_at: null, full_text: 'body', summary: 's' })
    insertArticle({ feed_id: feed.id, title: 'b', url: 'http://example.com/2', published_at: null, full_text: 'body' })
    insertArticle({ feed_id: clip.id, title: 'x', url: 'http://example.com/3', published_at: null, full_text: 'body' })

    const res = await app.inject({ method: 'GET', url: '/api/settings/summary/status' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ total: 2, summarized: 1, missing: 1, backfillRunning: false })
  })
})

describe('POST /api/settings/summary/run', () => {
  it('is a no-op with 400 when no provider is configured', async () => {
    seedMissingArticles(2)
    mockShouldAutoSummarize.mockReturnValue(false)

    const res = await app.inject({ method: 'POST', url: '/api/settings/summary/run' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/not enabled|provider/i)
    expect(res.json().running).toBe(false)
  })

  it('starts a run and reports 409 for a second concurrent start (single-flight)', async () => {
    seedMissingArticles(5)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    mockAutoSummarize.mockImplementation(async (articleId: number) => {
      await gate
      updateArticleContent(articleId, { summary: `s-${articleId}` })
      return true
    })

    const first = await app.inject({ method: 'POST', url: '/api/settings/summary/run' })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ ok: true, started: true, backfillRunning: true })

    const second = await app.inject({ method: 'POST', url: '/api/settings/summary/run' })
    expect(second.statusCode).toBe(409)
    expect(second.json().running).toBe(true)

    release()
    await whenSummaryBackfillSettles()

    const status = await app.inject({ method: 'GET', url: '/api/settings/summary/status' })
    expect(status.json()).toMatchObject({ backfillRunning: false, backfillQueue: 0, summarized: 5 })
  })

  it('reports progress via the status endpoint while the run is active', async () => {
    seedMissingArticles(6)
    upsertSetting('summary.concurrency', '4')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    mockAutoSummarize.mockImplementation(() => gate.then(() => true))

    await app.inject({ method: 'POST', url: '/api/settings/summary/run' })
    const mid = await app.inject({ method: 'GET', url: '/api/settings/summary/status' })
    expect(mid.json()).toMatchObject({ backfillRunning: true, backfillQueue: 6 })

    release()
    await whenSummaryBackfillSettles()
  })

  it('responds with started:false (not an error) when nothing is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/settings/summary/run' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, started: false, missing: 0 })
  })
})
