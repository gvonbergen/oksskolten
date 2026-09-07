import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb } from '../__tests__/helpers/testDb.js'
import { upsertSetting } from '../db.js'

// The chat search tool goes hybrid through the search client when the
// semantic runtime reports ready; these tests pin the hybrid parameters
// (embedder + configured semantic ratio) and the keyword fallback path.
vi.mock('../search/sync.js', () => ({
  isSearchReady: vi.fn(() => true),
  isSemanticReady: vi.fn(() => false),
  requestSearchRebuild: vi.fn(),
  isRebuilding: vi.fn(() => false),
}))

const mockSearchWithHybrid = vi.fn()

vi.mock('../search/client.js', () => ({
  buildMeiliFilter: vi.fn(() => undefined),
  hasMeaningfulSearchQuery: vi.fn((query: string) => (query.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2),
  meiliSearch: vi.fn(async () => ({ hits: [], estimatedTotalHits: 0 })),
  searchArticlesWithHybrid: (...args: unknown[]) => mockSearchWithHybrid(...(args as Parameters<typeof mockSearchWithHybrid>)),
}))

import { isSemanticReady } from '../search/sync.js'
import { executeTool } from './tools.js'

const mockIsSemanticReady = vi.mocked(isSemanticReady)

beforeEach(() => {
  setupTestDb()
  mockIsSemanticReady.mockReturnValue(true)
  mockSearchWithHybrid.mockReset()
  mockSearchWithHybrid.mockResolvedValue({ hits: [], estimatedTotalHits: 0, searchMode: 'hybrid' })
})

describe('chat search_article tool — hybrid semantic ratio', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the configured semantic ratio for hybrid queries', async () => {
    upsertSetting('embedding.semantic_ratio', '0.75')
    await executeTool('search_articles', { query: 'distributed consensus' })
    const opts = mockSearchWithHybrid.mock.calls[0][1]
    expect(opts.hybrid).toEqual({ embedder: 'article-v1', semanticRatio: 0.75 })
  })

  it('defaults to 0.25 when no ratio is configured', async () => {
    await executeTool('search_articles', { query: 'distributed consensus' })
    const opts = mockSearchWithHybrid.mock.calls[0][1]
    expect(opts.hybrid).toEqual({ embedder: 'article-v1', semanticRatio: 0.25 })
  })

  it('stays keyword-only when semantic is not ready (fallback preserved)', async () => {
    mockIsSemanticReady.mockReturnValue(false)
    await executeTool('search_articles', { query: 'distributed consensus' })
    const opts = mockSearchWithHybrid.mock.calls[0][1]
    expect(opts.hybrid).toBeUndefined()
  })
})
