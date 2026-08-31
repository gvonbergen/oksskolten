import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setupTestDb } from '../__tests__/helpers/testDb.js'
import { getDb } from '../db/connection.js'

// Mock Meilisearch client. Each method is exposed individually so individual
// tests can override the return value (e.g. simulate "no indexes yet").
const mockWaitTask = vi.fn().mockResolvedValue({})
const mockUpdateDocuments = vi.fn().mockReturnValue({ waitTask: mockWaitTask })
const mockAddDocuments = vi.fn().mockReturnValue({ waitTask: mockWaitTask })
const mockUpdateSettings = vi.fn().mockReturnValue({ waitTask: mockWaitTask })
const mockGetStats = vi.fn()
const mockGetIndexes = vi.fn()
const mockGetSettings = vi.fn()
const mockCreateIndex = vi.fn().mockReturnValue({ waitTask: mockWaitTask })
const mockDeleteIndex = vi.fn().mockReturnValue({ waitTask: mockWaitTask })
const mockDeleteDocument = vi.fn().mockReturnValue({ waitTask: mockWaitTask })
const mockDeleteDocuments = vi.fn().mockReturnValue({ waitTask: mockWaitTask })
const mockSwapIndexes = vi.fn().mockReturnValue({ waitTask: mockWaitTask })
vi.mock('./client.js', () => ({
  getSearchClient: () => ({
    getIndexes: mockGetIndexes,
    index: () => ({
      updateDocuments: mockUpdateDocuments,
      addDocuments: mockAddDocuments,
      updateSettings: mockUpdateSettings,
      getStats: mockGetStats,
      getSettings: mockGetSettings,
      deleteDocument: mockDeleteDocument,
      deleteDocuments: mockDeleteDocuments,
    }),
    createIndex: mockCreateIndex,
    deleteIndex: mockDeleteIndex,
    swapIndexes: mockSwapIndexes,
  }),
  ARTICLES_INDEX: 'articles',
  ARTICLES_STAGING_INDEX: 'articles_staging',
}))

import { ensureSearchIndex, isSearchReady, isSemanticReady, isRebuilding, syncAllScoredArticlesToSearch, syncArticlesByFeedToSearch, _setRebuilding, _setSearchReady, _setLiveEmbedderVerified, _resetRebuildRecord, rebuildSearchIndex, getSearchIndexRuntime, resolveIndexSettings } from './sync.js'
import { upsertSetting, deleteSetting } from '../db.js'

function seedFeed(): number {
  return getDb().prepare(
    "INSERT INTO feeds (name, url) VALUES ('Test', 'https://example.com/feed')"
  ).run().lastInsertRowid as number
}

function seedArticle(feedId: number, opts: { url: string; published_at?: string }): number {
  return getDb().prepare(
    'INSERT INTO articles (feed_id, title, url, published_at) VALUES (?, ?, ?, ?)'
  ).run(feedId, 'Test Article', opts.url, opts.published_at ?? new Date().toISOString()).lastInsertRowid as number
}

describe('syncAllScoredArticlesToSearch', () => {
  beforeEach(() => {
    setupTestDb()
    mockUpdateDocuments.mockClear()
    mockWaitTask.mockClear()
    _setRebuilding(false)
  })

  it('syncs articles with engagement to Meilisearch and returns count', async () => {
    const feedId = seedFeed()
    const id1 = seedArticle(feedId, { url: 'https://example.com/1' })
    seedArticle(feedId, { url: 'https://example.com/2' })

    getDb().prepare("UPDATE articles SET liked_at = datetime('now'), score = 10.0 WHERE id = ?").run(id1)

    const synced = await syncAllScoredArticlesToSearch()

    expect(synced).toBe(1)
    expect(mockUpdateDocuments).toHaveBeenCalledTimes(1)
    const docs = mockUpdateDocuments.mock.calls[0][0] as { id: number; score: number }[]
    expect(docs).toHaveLength(1)
    expect(docs[0].id).toBe(id1)
    expect(docs[0].score).toBeGreaterThan(0)
    expect(mockWaitTask).toHaveBeenCalledTimes(1)
  })

  it('returns 0 when no articles qualify', async () => {
    const feedId = seedFeed()
    seedArticle(feedId, { url: 'https://example.com/no-engagement' })

    const synced = await syncAllScoredArticlesToSearch()

    expect(synced).toBe(0)
    expect(mockUpdateDocuments).not.toHaveBeenCalled()
  })

  it('includes articles with score > 0 but no engagement flags', async () => {
    const feedId = seedFeed()
    const id1 = seedArticle(feedId, { url: 'https://example.com/residual' })

    getDb().prepare('UPDATE articles SET score = 5.0 WHERE id = ?').run(id1)

    await syncAllScoredArticlesToSearch()

    expect(mockUpdateDocuments).toHaveBeenCalledTimes(1)
    const docs = mockUpdateDocuments.mock.calls[0][0] as { id: number; score: number }[]
    expect(docs).toHaveLength(1)
    expect(docs[0].id).toBe(id1)
  })

  it('syncs multiple qualifying articles in one call', async () => {
    const feedId = seedFeed()
    const id1 = seedArticle(feedId, { url: 'https://example.com/a' })
    const id2 = seedArticle(feedId, { url: 'https://example.com/b' })
    const id3 = seedArticle(feedId, { url: 'https://example.com/c' })

    getDb().prepare("UPDATE articles SET liked_at = datetime('now'), score = 10.0 WHERE id = ?").run(id1)
    getDb().prepare("UPDATE articles SET bookmarked_at = datetime('now'), score = 5.0 WHERE id = ?").run(id2)
    getDb().prepare("UPDATE articles SET read_at = datetime('now'), score = 2.0 WHERE id = ?").run(id3)

    await syncAllScoredArticlesToSearch()

    expect(mockUpdateDocuments).toHaveBeenCalledTimes(1)
    const docs = mockUpdateDocuments.mock.calls[0][0] as { id: number; score: number }[]
    expect(docs).toHaveLength(3)
    const ids = docs.map(d => d.id).sort()
    expect(ids).toEqual([id1, id2, id3].sort())
  })

  it('returns 0 and skips sync when index rebuild is in progress', async () => {
    const feedId = seedFeed()
    const id1 = seedArticle(feedId, { url: 'https://example.com/rebuilding' })
    getDb().prepare("UPDATE articles SET liked_at = datetime('now'), score = 10.0 WHERE id = ?").run(id1)

    _setRebuilding(true)

    const synced = await syncAllScoredArticlesToSearch()

    expect(synced).toBe(0)
    expect(mockUpdateDocuments).not.toHaveBeenCalled()
  })

  it('sends only id and score fields to Meilisearch', async () => {
    const feedId = seedFeed()
    const id1 = seedArticle(feedId, { url: 'https://example.com/fields' })
    getDb().prepare("UPDATE articles SET liked_at = datetime('now'), score = 7.5 WHERE id = ?").run(id1)

    await syncAllScoredArticlesToSearch()

    const docs = mockUpdateDocuments.mock.calls[0][0] as Record<string, unknown>[]
    expect(Object.keys(docs[0]).sort()).toEqual(['id', 'score'])
  })
})

describe('article sync embedding policy', () => {
  beforeEach(() => {
    setupTestDb()
    _setRebuilding(false)
    mockAddDocuments.mockClear()
  })

  it('adds the null vector marker when a bulk-synced article has no summary', () => {
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-embedding')
    mockAddDocuments.mockReturnValueOnce({ catch: vi.fn().mockResolvedValue(undefined) })

    syncArticlesByFeedToSearch([{
      id: 1,
      feed_id: 1,
      category_id: null,
      title: 'Article',
      summary: null,
      full_text: 'Body',
      full_text_translated: '',
      lang: 'en',
      published_at: 1,
      score: 0,
      is_unread: true,
      is_liked: false,
      is_bookmarked: false,
    }])

    expect(mockAddDocuments.mock.calls[0][0][0]._vectors).toEqual({ 'article-v1': null })
  })

  it('marks live-index writes as opt-outs during a disabled rebuild', () => {
    upsertSetting('embedding.enabled', 'off')
    _setRebuilding(true)
    mockAddDocuments.mockReturnValueOnce({ catch: vi.fn().mockResolvedValue(undefined) })

    syncArticlesByFeedToSearch([{
      id: 1,
      feed_id: 1,
      category_id: null,
      title: 'Article',
      summary: 'Summary',
      full_text: 'Body',
      full_text_translated: '',
      lang: 'en',
      published_at: 1,
      score: 0,
      is_unread: true,
      is_liked: false,
      is_bookmarked: false,
    }])

    expect(mockAddDocuments.mock.calls[0][0][0]._vectors).toEqual({ 'article-v1': null })
  })
})

describe('ensureSearchIndex', () => {
  beforeEach(() => {
    setupTestDb()
    mockGetIndexes.mockReset()
    mockGetStats.mockReset()
    mockCreateIndex.mockClear()
    mockDeleteIndex.mockClear()
    mockAddDocuments.mockClear()
    mockSwapIndexes.mockClear()
    mockUpdateSettings.mockClear()
    mockUpdateDocuments.mockClear()
    mockWaitTask.mockClear()
    _setRebuilding(false)
    _setSearchReady(false)
  })

  it('skips rebuild when the articles index already has documents and reapplies settings idempotently', async () => {
    mockGetIndexes.mockResolvedValue({ results: [{ uid: 'articles' }] })
    mockGetStats.mockResolvedValue({ numberOfDocuments: 42 })

    await ensureSearchIndex()

    expect(isSearchReady()).toBe(true)
    // Skipping means we never touch the heavy create / swap operations.
    expect(mockCreateIndex).not.toHaveBeenCalled()
    expect(mockDeleteIndex).not.toHaveBeenCalled()
    expect(mockAddDocuments).not.toHaveBeenCalled()
    // Settings must still be reapplied so a redeploy that changed the
    // schema (new filterable attribute, etc.) picks it up without waiting
    // for the 6h cron rebuild.
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    const appliedSettings = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>
    expect(appliedSettings).toHaveProperty('filterableAttributes')
    expect(appliedSettings).toHaveProperty('searchableAttributes')
  })

  it('falls through to rebuild when the articles index is missing', async () => {
    mockGetIndexes.mockResolvedValue({ results: [] })

    await ensureSearchIndex()

    expect(mockCreateIndex).toHaveBeenCalled()
  })

  it('falls through to rebuild when the articles index is empty', async () => {
    mockGetIndexes.mockResolvedValue({ results: [{ uid: 'articles' }] })
    mockGetStats.mockResolvedValue({ numberOfDocuments: 0 })

    await ensureSearchIndex()

    expect(mockCreateIndex).toHaveBeenCalled()
  })

  it('falls through to rebuild when the existence check throws', async () => {
    // Meilisearch transient failure on the first existence check; the
    // function should still try a rebuild rather than declaring search
    // ready against an unknown state.
    mockGetIndexes.mockRejectedValueOnce(new Error('connection refused'))
    mockGetIndexes.mockResolvedValue({ results: [] })

    await ensureSearchIndex()

    expect(mockCreateIndex).toHaveBeenCalled()
  })

  it('throws on settings-apply failure without triggering a full rebuild', async () => {
    // Index is populated, so the skip path applies. If updateSettings hits
    // a timeout (the same queue-pressure symptom that motivated this
    // change), we must NOT cascade into the heavy rebuild because that
    // would worsen the queue. Surface the error to the startup retry loop
    // instead.
    mockGetIndexes.mockResolvedValue({ results: [{ uid: 'articles' }] })
    mockGetStats.mockResolvedValue({ numberOfDocuments: 42 })
    mockWaitTask.mockRejectedValueOnce(new Error('MeiliSearchTaskTimeOutError: timeout'))

    await expect(ensureSearchIndex()).rejects.toThrow()
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    // The full-rebuild operations must not have been reached.
    expect(mockCreateIndex).not.toHaveBeenCalled()
    expect(mockDeleteIndex).not.toHaveBeenCalled()
    expect(mockSwapIndexes).not.toHaveBeenCalled()
    expect(isSearchReady()).toBe(false)
  })

  it('degrades to keyword-only search when the settings task fails deterministically', async () => {
    // An invalid embedder configuration (e.g. unsupported dimensions for the
    // model) makes the settings task fail on every retry. The production
    // keyword index is intact, so startup must keep search available instead
    // of throwing into the retry loop and 503-ing all search.
    upsertSetting('summary.auto', 'on')
    upsertSetting('summary.provider', 'openai')
    upsertSetting('summary.model', 'gpt-4.1-mini')
    upsertSetting('api_key.openai', 'sk-summary')
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.dimensions', '8192')
    mockGetIndexes.mockResolvedValue({ results: [{ uid: 'articles' }] })
    mockGetStats.mockResolvedValue({ numberOfDocuments: 42 })
    mockWaitTask.mockResolvedValueOnce({ status: 'failed', error: { message: 'invalid dimensions' } })

    await ensureSearchIndex()

    expect(isSearchReady()).toBe(true)
    expect(isSemanticReady()).toBe(false)
    // Heavy rebuild operations must not cascade from the failed settings task.
    expect(mockCreateIndex).not.toHaveBeenCalled()
    expect(mockSwapIndexes).not.toHaveBeenCalled()
    const runtime = await getSearchIndexRuntime()
    expect(runtime.lastRebuild?.ok).toBe(false)
    expect(runtime.lastRebuild?.error).toContain('production settings update failed')
    expect(runtime.lastRebuild?.error).toContain('invalid dimensions')
  })

  it('throws when the fallthrough rebuild fails so the startup retry loop can back off', async () => {
    // No indexes exist, so ensureSearchIndex must fall through to rebuild.
    // Make rebuildSearchIndex hit a hard failure that its internal catch
    // will swallow without setting searchReady. ensureSearchIndex must
    // surface that as a thrown error to its caller.
    mockGetIndexes.mockResolvedValueOnce({ results: [] }) // ensure check: no articles
    mockGetIndexes.mockRejectedValueOnce(new Error('meili down')) // rebuild's own check

    await expect(ensureSearchIndex()).rejects.toThrow(/rebuild/i)
    expect(isSearchReady()).toBe(false)
  })
})

describe('embedder lifecycle — regression for #117 (rebuild must not lose the embedder)', () => {
  beforeEach(() => {
    setupTestDb()
    mockGetIndexes.mockReset()
    mockGetStats.mockReset()
    mockGetSettings.mockReset()
    mockGetSettings.mockResolvedValue({
      embedders: {
        'article-v1': { source: 'openAi', model: 'text-embedding-3-small', dimensions: 1536, documentTemplate: '{{doc.title}}\n\n{{doc.summary}}', apiKey: 'sk-live-copy' },
      },
    })
    mockCreateIndex.mockClear()
    mockDeleteIndex.mockClear()
    mockAddDocuments.mockClear()
    mockSwapIndexes.mockClear()
    mockUpdateSettings.mockClear()
    mockUpdateDocuments.mockClear()
    mockWaitTask.mockClear()
    _setRebuilding(false)
    _setSearchReady(false)
    _setLiveEmbedderVerified(false)
    _resetRebuildRecord()
  })

  function seedEmbeddingSettings() {
    // The embedding runtime requires automatic summarization to be
    // configured and enabled (enforced by the settings API too).
    upsertSetting('summary.auto', 'on')
    upsertSetting('summary.provider', 'openai')
    upsertSetting('summary.model', 'gpt-4.1-mini')
    upsertSetting('api_key.openai', 'sk-summary')
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.dimensions', '1536')
    upsertSetting('embedding.api_key', 'sk-embedding-test')
  }

  it('resolveIndexSettings includes the managed embedder when enabled and stays keyword-only when disabled', () => {
    seedEmbeddingSettings()
    const settings = resolveIndexSettings() as Record<string, unknown>
    expect(settings.embedders).toBeDefined()
    const embedders = settings.embedders as Record<string, unknown>
    expect(Object.keys(embedders)).toEqual(['article-v1'])

    upsertSetting('embedding.enabled', 'off')
    const disabled = resolveIndexSettings() as Record<string, unknown>
    expect(disabled.embedders).toBeUndefined()
  })

  it('rebuild applies the embedder to the new staging index before documents — no embedder is lost after create/swap/delete', async () => {
    seedEmbeddingSettings()
    const feedId = seedFeed()
    const summarized = seedArticle(feedId, { url: 'https://example.com/summarized' })
    seedArticle(feedId, { url: 'https://example.com/plain' })
    getDb().prepare('UPDATE articles SET summary = ? WHERE id = ?').run('A short summary.', summarized)

    mockGetIndexes.mockResolvedValue({ results: [{ uid: 'articles' }, { uid: 'articles_staging' }] })

    await rebuildSearchIndex()

    // Staging settings carried the embedder (the #117 regression path)
    const stagingSettings = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>
    expect(stagingSettings.embedders).toBeDefined()
    expect((stagingSettings.embedders as Record<string, unknown>)['article-v1']).toMatchObject({
      source: 'openAi',
      model: 'text-embedding-3-small',
    })

    // Documents carry summary and _vectors markers: summarized docs are
    // embedded from the template, un-summarized docs are explicitly skipped.
    const docs = mockAddDocuments.mock.calls[0][0] as Record<string, unknown>[]
    expect(docs).toHaveLength(2)
    const byUrl = Object.fromEntries(docs.map(d => [d.id, d]))
    const summarizedDoc = byUrl[summarized]
    expect(summarizedDoc.summary).toBe('A short summary.')
    expect(summarizedDoc._vectors).toBeUndefined()
    const plainDoc = docs.find(d => d.id !== summarized)!
    expect(plainDoc._vectors).toEqual({ 'article-v1': null })

    expect(isSearchReady()).toBe(true)
    expect(isSemanticReady()).toBe(true)
    const runtime = await getSearchIndexRuntime()
    expect(runtime.lastRebuild).toMatchObject({ processedDocuments: 2, totalDocuments: 2, documents: 2 })
  })

  it('startup reconciliation re-applies the embedder to an already-populated production index', async () => {
    seedEmbeddingSettings()
    const feedId = seedFeed()
    for (let i = 0; i < 7; i++) seedArticle(feedId, { url: `https://example.com/startup-${i}` })
    mockGetIndexes.mockResolvedValue({ results: [{ uid: 'articles' }] })
    mockGetStats.mockResolvedValue({ numberOfDocuments: 7 })
    mockGetSettings.mockResolvedValue({
      embedders: {
        'article-v1': { source: 'openAi', model: 'text-embedding-3-small', dimensions: 1536, documentTemplate: '{{doc.title}}\n\n{{doc.summary}}', apiKey: 'sk-live-copy' },
      },
    })

    await ensureSearchIndex()

    const applied = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>
    expect(applied.embedders).toBeDefined()
    expect(isSearchReady()).toBe(true)
    // The live index carries the expected embedder (secrets stripped in the comparison)
    expect(isSemanticReady()).toBe(true)
  })

  it('startup reconciliation clears a stale embedder when embeddings are disabled', async () => {
    seedEmbeddingSettings()
    upsertSetting('embedding.enabled', 'off')
    const feedId = seedFeed()
    for (let i = 0; i < 7; i++) seedArticle(feedId, { url: `https://example.com/disabled-${i}` })
    mockGetIndexes.mockResolvedValue({ results: [{ uid: 'articles' }] })
    mockGetStats.mockResolvedValue({ numberOfDocuments: 7 })

    await ensureSearchIndex()

    expect(mockUpdateSettings.mock.calls[0][0]).toMatchObject({ embedders: {} })
    expect(isSemanticReady()).toBe(false)
  })

  it('semantic readiness stays false when the live index lacks the expected embedder', async () => {
    seedEmbeddingSettings()
    const feedId = seedFeed()
    for (let i = 0; i < 7; i++) seedArticle(feedId, { url: `https://example.com/missing-${i}` })
    mockGetIndexes.mockResolvedValue({ results: [{ uid: 'articles' }] })
    mockGetStats.mockResolvedValue({ numberOfDocuments: 7 })
    mockGetSettings.mockResolvedValue({ embedders: null })

    await ensureSearchIndex()

    expect(isSearchReady()).toBe(true)
    expect(isSemanticReady()).toBe(false)
  })

  it('a failed document batch task aborts before the swap and records the error', async () => {
    seedEmbeddingSettings()
    const feedId = seedFeed()
    seedArticle(feedId, { url: 'https://example.com/bad' })
    mockGetIndexes.mockResolvedValue({ results: [{ uid: 'articles' }] })
    mockAddDocuments.mockReturnValueOnce({
      waitTask: vi.fn().mockResolvedValue({ status: 'failed', error: { message: 'Embedding generation failed: sk-embedding-test' } }),
    })

    await rebuildSearchIndex()

    expect(mockSwapIndexes).not.toHaveBeenCalled()
    expect(isSearchReady()).toBe(false)
    const runtime = await getSearchIndexRuntime()
    expect(runtime.lastRebuild?.ok).toBe(false)
    expect(runtime.lastRebuild?.error).toContain('Embedding generation failed')
    expect(runtime.lastRebuild?.error).not.toContain('sk-embedding-test')
  })

  it('a failed staging settings task aborts before the swap and records the error', async () => {
    // waitForTask resolves (does not throw) on a failed task, e.g. an invalid
    // embedder model/dimensions combination, so the rebuild must check the
    // task status and abort before promoting the embedderless staging index.
    seedEmbeddingSettings()
    const feedId = seedFeed()
    seedArticle(feedId, { url: 'https://example.com/settings-fail' })
    mockGetIndexes.mockResolvedValue({ results: [{ uid: 'articles' }] })
    mockUpdateSettings.mockReturnValueOnce({
      waitTask: vi.fn().mockResolvedValue({ status: 'failed', error: { message: 'Invalid embedder configuration: model `nope`' } }),
    })

    await rebuildSearchIndex()

    expect(mockSwapIndexes).not.toHaveBeenCalled()
    expect(mockAddDocuments).not.toHaveBeenCalled()
    expect(isSearchReady()).toBe(false)
    expect(isSemanticReady()).toBe(false)
    const runtime = await getSearchIndexRuntime()
    expect(runtime.lastRebuild?.ok).toBe(false)
    expect(runtime.lastRebuild?.error).toContain('Invalid embedder configuration')
  })

  it('a failed swap task is treated as indeterminate and reconciliation reruns safely', async () => {
    seedEmbeddingSettings()
    const feedId = seedFeed()
    seedArticle(feedId, { url: 'https://example.com/swap-timeout' })
    mockGetIndexes.mockResolvedValue({ results: [{ uid: 'articles' }] })
    // The swap is accepted but waiting for it times out; the enqueued swap
    // may still complete later, so the rebuild must not report success and
    // must schedule a reconciliation rerun instead of discarding state.
    mockSwapIndexes.mockReturnValueOnce({
      waitTask: vi.fn().mockRejectedValue(new Error('MeiliSearchTaskTimeOutError: timeout')),
    })

    await rebuildSearchIndex()

    expect(isSearchReady()).toBe(false)
    // The rebuild treats the timed-out swap as indeterminate and schedules
    // the reconciliation rerun right away.
    expect(isRebuilding()).toBe(true)

    // The reconciliation rerun completes the rebuild safely.
    await vi.waitFor(() => expect(isRebuilding()).toBe(false))
    expect(isSearchReady()).toBe(true)
    const recovered = await getSearchIndexRuntime()
    expect(recovered.lastRebuild?.ok).toBe(true)
  })

  it('disabling embeddings rebuilds without an embedder and drops semantic readiness', async () => {
    seedEmbeddingSettings()
    const feedId = seedFeed()
    seedArticle(feedId, { url: 'https://example.com/a' })
    mockGetIndexes.mockResolvedValue({ results: [] })

    await rebuildSearchIndex()
    expect(isSemanticReady()).toBe(true)

    upsertSetting('embedding.enabled', 'off')
    _setLiveEmbedderVerified(false)
    mockAddDocuments.mockClear()

    // Second (keyword-only) rebuild
    await rebuildSearchIndex()
    const settings = mockUpdateSettings.mock.calls[1][0] as Record<string, unknown>
    expect(settings.embedders).toBeUndefined()
    const docs = mockAddDocuments.mock.calls[0][0] as Record<string, unknown>[]
    expect(docs[0]._vectors).toEqual({ 'article-v1': null })
    expect(isSemanticReady()).toBe(false)
  })

  it('does not start duplicate concurrent rebuilds', async () => {
    mockGetIndexes.mockResolvedValue({ results: [] })
    const first = rebuildSearchIndex()
    const second = rebuildSearchIndex()
    await Promise.all([first, second])
    expect(mockGetIndexes).toHaveBeenCalledTimes(1)
  })

  it('getSearchIndexRuntime reports stats from Meilisearch with semantic readiness', async () => {
    seedEmbeddingSettings()
    _setSearchReady(true)
    _setLiveEmbedderVerified(true)
    mockGetStats.mockResolvedValue({
      numberOfDocuments: 10,
      numberOfEmbeddedDocuments: 8,
      numberOfEmbeddings: 8,
    })

    const runtime = await getSearchIndexRuntime()
    expect(runtime.semanticReady).toBe(true)
    expect(runtime.index?.documents).toBe(10)
    expect(runtime.index?.embeddedDocuments).toBe(8)
    expect(runtime.index?.embeddings).toBe(8)
  })
})

describe('semantic readiness reacts to prerequisite changes at runtime', () => {
  beforeEach(() => {
    setupTestDb()
    _resetRebuildRecord()
    _setSearchReady(true)
    _setLiveEmbedderVerified(true)
  })

  it('drops hybrid readiness when automatic summarization is disabled later', () => {
    upsertSetting('summary.auto', 'on')
    upsertSetting('summary.provider', 'openai')
    upsertSetting('summary.model', 'gpt-4.1-mini')
    upsertSetting('api_key.openai', 'sk-sum')
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-embed')

    expect(isSemanticReady()).toBe(true)

    // Automatic summarization switched off — embeddings must stop operating
    // (keyword-only) even though the toggle is still on.
    deleteSetting('summary.auto')
    expect(isSemanticReady()).toBe(false)

    // Re-enabling the prerequisite requires a fresh coverage rebuild.
    upsertSetting('summary.auto', 'on')
    expect(isSemanticReady()).toBe(false)
  })

  it('stays keyword-only when the provider credential is removed', () => {
    upsertSetting('summary.auto', 'on')
    upsertSetting('summary.provider', 'openai')
    upsertSetting('summary.model', 'gpt-4.1-mini')
    upsertSetting('api_key.openai', 'sk-sum')
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-embed')

    expect(isSemanticReady()).toBe(true)
    deleteSetting('embedding.api_key')
    expect(isSemanticReady()).toBe(false)
  })
})
