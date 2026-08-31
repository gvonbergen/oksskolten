import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockIndexSearch = vi.fn()

vi.mock('meilisearch', () => ({
  MeiliSearch: class {
    index() {
      return { search: mockIndexSearch }
    }
  },
}))

import { searchArticlesWithHybrid } from './client.js'

describe('searchArticlesWithHybrid', () => {
  beforeEach(() => {
    mockIndexSearch.mockReset()
  })

  it('uses plain keyword search when no hybrid option is passed', async () => {
    mockIndexSearch.mockResolvedValue({ hits: [{ id: 1 }, { id: 2 }], estimatedTotalHits: 2 })
    const result = await searchArticlesWithHybrid('hello', { limit: 5 })
    expect(result.searchMode).toBe('keyword')
    expect(result.hits).toEqual([{ id: 1 }, { id: 2 }])
    expect(mockIndexSearch).toHaveBeenCalledTimes(1)
    const params = mockIndexSearch.mock.calls[0][1]
    expect(params.hybrid).toBeUndefined()
    expect(params.limit).toBe(5)
  })

  it('passes the hybrid parameter and preserves filters/pagination/sort', async () => {
    mockIndexSearch.mockResolvedValue({ hits: [{ id: 3 }], estimatedTotalHits: 9 })
    const result = await searchArticlesWithHybrid('distributed systems', {
      limit: 10,
      offset: 20,
      filter: 'feed_id = 4',
      sort: ['published_at:desc'],
      hybrid: { embedder: 'article-v1', semanticRatio: 0.25 },
    })
    expect(result.searchMode).toBe('hybrid')
    const params = mockIndexSearch.mock.calls[0][1]
    expect(params.hybrid).toEqual({ embedder: 'article-v1', semanticRatio: 0.25 })
    expect(params.filter).toBe('feed_id = 4')
    expect(params.offset).toBe(20)
    expect(params.sort).toEqual(['published_at:desc'])
    expect(params.attributesToRetrieve).toEqual(['id'])
  })

  it('falls back to keyword results when the hybrid query embedding fails', async () => {
    mockIndexSearch
      .mockRejectedValueOnce(new Error('Embedding request failed'))
      .mockResolvedValueOnce({ hits: [{ id: 7 }], estimatedTotalHits: 1 })
    const result = await searchArticlesWithHybrid('paraphrase me', {
      hybrid: { embedder: 'article-v1', semanticRatio: 0.25 },
    })
    expect(result.searchMode).toBe('keyword-fallback')
    expect(result.hits).toEqual([{ id: 7 }])
    // Exactly one retry without hybrid
    expect(mockIndexSearch).toHaveBeenCalledTimes(2)
    expect(mockIndexSearch.mock.calls[1][1].hybrid).toBeUndefined()
  })

  it('propagates the error when the keyword retry fails too (real Meili outage)', async () => {
    mockIndexSearch.mockRejectedValue(new Error('meili down'))
    await expect(
      searchArticlesWithHybrid('query', { hybrid: { embedder: 'article-v1', semanticRatio: 0.25 } }),
    ).rejects.toThrow('meili down')
  })
})