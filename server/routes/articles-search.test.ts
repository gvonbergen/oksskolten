import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb } from '../__tests__/helpers/testDb.js'
import { buildApp } from '../__tests__/helpers/buildApp.js'
import { createFeed, insertArticle } from '../db.js'
import type { FastifyInstance } from 'fastify'

vi.mock('../search/sync.js', () => {
  return {
    isSearchReady: vi.fn(() => true),
    isSemanticReady: vi.fn(() => false),
    getSearchIndexRuntime: vi.fn(async () => ({ semanticReady: false, rebuilding: false, lastRebuild: null, index: null })),
    requestSearchRebuild: vi.fn(),
    isRebuilding: vi.fn(() => false),
    rebuildSearchIndex: vi.fn(async () => {}),
    ensureSearchIndex: vi.fn(async () => {}),
    syncAllScoredArticlesToSearch: vi.fn(async () => 0),
    syncArticleToSearch: vi.fn(),
    deleteArticleFromSearch: vi.fn(),
    deleteArticlesFromSearch: vi.fn(),
    syncArticleScoreToSearch: vi.fn(),
    syncArticleFiltersToSearch: vi.fn(),
    syncArticlesByFeedToSearch: vi.fn(),
  }
})

const mockSearchWithHybrid = vi.fn()

vi.mock('../search/client.js', () => ({
  buildMeiliFilter: vi.fn((opts: Record<string, unknown>) => {
    const parts: string[] = []
    if (opts.feed_id) parts.push(`feed_id = ${opts.feed_id}`)
    if (opts.unread === true) parts.push('is_unread = true')
    return parts.length > 0 ? parts.join(' AND ') : undefined
  }),
  meiliSearch: vi.fn(async () => ({ hits: [], estimatedTotalHits: 0 })),
  searchArticlesWithHybrid: (...args: unknown[]) => mockSearchWithHybrid(...(args as Parameters<typeof mockSearchWithHybrid>)),
}))

import { isSemanticReady } from '../search/sync.js'

const mockIsSemanticReady = vi.mocked(isSemanticReady)

let app: FastifyInstance

function seed() {
  const feed = createFeed({ name: 'Test', url: 'https://example.com/feed' })
  const id = insertArticle({
    feed_id: feed.id,
    title: 'Rust async internals',
    url: 'https://example.com/rust-async',
    published_at: '2025-01-01T00:00:00Z',
    summary: 'How async tasks are scheduled in Rust',
  })
  return { feedId: feed.id, id }
}

describe('GET /api/articles/search — hybrid semantic + keyword with fallback', () => {
  beforeEach(async () => {
    setupTestDb()
    mockIsSemanticReady.mockReturnValue(false)
    mockSearchWithHybrid.mockReset()
    mockSearchWithHybrid.mockResolvedValue({ hits: [{ id: 1 }], estimatedTotalHits: 1, searchMode: 'keyword' })
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns 503 while the keyword index is not built (unchanged behavior)', async () => {
    const { isSearchReady } = await import('../search/sync.js')
    vi.mocked(isSearchReady).mockReturnValueOnce(false)
    const res = await app.inject({ method: 'GET', url: '/api/articles/search?q=rust' })
    expect(res.statusCode).toBe(503)
    expect(mockSearchWithHybrid).not.toHaveBeenCalled()
  })

  it('uses hybrid search when semantic is ready and reports search_mode=hybrid', async () => {
    seed()
    mockIsSemanticReady.mockReturnValue(true)
    mockSearchWithHybrid.mockResolvedValue({ hits: [{ id: 1 }], estimatedTotalHits: 1, searchMode: 'hybrid' })

    const res = await app.inject({ method: 'GET', url: '/api/articles/search?q=async+task+scheduling' })
    expect(res.statusCode).toBe(200)
    expect(res.json().search_mode).toBe('hybrid')
    expect(res.json().articles).toHaveLength(1)
    const [query, opts] = mockSearchWithHybrid.mock.calls[0]
    expect(query).toBe('async task scheduling')
    expect(opts.hybrid).toEqual(expect.objectContaining({ embedder: 'article-v1' }))
  })

  it('returns keyword results with search_mode=keyword-fallback when the embedding fails — never empty', async () => {
    seed()
    mockIsSemanticReady.mockReturnValue(true)
    mockSearchWithHybrid.mockResolvedValue({ hits: [{ id: 1 }], estimatedTotalHits: 1, searchMode: 'keyword-fallback' })

    const res = await app.inject({ method: 'GET', url: '/api/articles/search?q=concurrency' })
    expect(res.statusCode).toBe(200)
    expect(res.json().search_mode).toBe('keyword-fallback')
    expect(res.json().articles).toHaveLength(1)
    expect(res.json().articles[0].title).toContain('Rust')
  })

  it('stays keyword-only when semantic is intentionally disabled', async () => {
    seed()
    const res = await app.inject({ method: 'GET', url: '/api/articles/search?q=rust' })
    expect(res.statusCode).toBe(200)
    expect(res.json().search_mode).toBe('keyword')
    const opts = mockSearchWithHybrid.mock.calls[0][1]
    expect(opts.hybrid).toBeUndefined()
  })

  it('converts boolean filter flags exactly as before and preserves pagination', async () => {
    seed()
    mockIsSemanticReady.mockReturnValue(true)
    mockSearchWithHybrid.mockResolvedValue({ hits: [{ id: 1 }], estimatedTotalHits: 5, searchMode: 'hybrid' })

    // unread=0 must disable the unread filter (unread=undefined), not set it false
    await app.inject({ method: 'GET', url: '/api/articles/search?q=rust&unread=0&limit=20&offset=20' })
    const opts = mockSearchWithHybrid.mock.calls[0][1]
    expect(opts.limit).toBe(20)
    expect(opts.offset).toBe(20)
  })
})