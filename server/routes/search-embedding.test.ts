import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { setupTestDb } from '../__tests__/helpers/testDb.js'
import { buildApp } from '../__tests__/helpers/buildApp.js'
import { upsertSetting, getSetting } from '../db.js'
import type { FastifyInstance } from 'fastify'

// The whole app is registered, so the search-sync module needs to exist for
// every consumer (articles routes, db sync helpers, similarity...). We mock it
// and drive its behavior per-test.
vi.mock('../search/sync.js', () => {
  const runtime = { semanticReady: false, rebuilding: false, lastRebuild: null, index: null }
  return {
    isSearchReady: vi.fn(() => true),
    isSemanticReady: vi.fn(() => runtime.semanticReady),
    getSearchIndexRuntime: vi.fn(async () => ({ ...runtime })),
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

import { requestSearchRebuild, isRebuilding, getSearchIndexRuntime } from '../search/sync.js'

const mockRequestRebuild = vi.mocked(requestSearchRebuild)
const mockIsRebuilding = vi.mocked(isRebuilding)
const mockGetRuntime = vi.mocked(getSearchIndexRuntime)

let app: FastifyInstance

function seedPrerequisite() {
  upsertSetting('summary.auto', 'on')
  upsertSetting('summary.provider', 'openai')
  upsertSetting('summary.model', 'gpt-4.1-mini')
  upsertSetting('api_key.openai', 'sk-summary')
}

const json = { 'content-type': 'application/json' }

describe('GET /api/settings/search-embedding', () => {
  beforeEach(async () => {
    setupTestDb()
    mockGetRuntime.mockResolvedValue({ semanticReady: false, rebuilding: false, lastRebuild: null, index: null })
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it('fresh installation reports disabled, no provider, and never leaks a secret', async () => {
    upsertSetting('embedding.api_key', 'sk-ultra-secret-value')
    const res = await app.inject({ method: 'GET', url: '/api/settings/search-embedding' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.enabled).toBe('off')
    expect(body.provider).toBeNull()
    expect(body.prerequisite.met).toBe(false)
    expect(body.semantic_ready).toBe(false)
    expect(body).not.toHaveProperty('api_key')
    expect(res.body).not.toContain('sk-ultra-secret-value')
  })

  it('reports configured credential without returning it', async () => {
    seedPrerequisite()
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-never-return-this')
    mockGetRuntime.mockResolvedValue({ semanticReady: true, rebuilding: false, lastRebuild: null, index: { documents: 5, embeddedDocuments: 3, embeddings: 3 } })

    const res = await app.inject({ method: 'GET', url: '/api/settings/search-embedding' })
    const body = res.json()
    expect(body.enabled).toBe('on')
    expect(body.api_key_configured).toBe(true)
    expect(body.semantic_ready).toBe(true)
    expect(res.body).not.toContain('sk-never-return-this')
  })
})

describe('PATCH /api/settings/search-embedding', () => {
  beforeEach(async () => {
    setupTestDb()
    mockRequestRebuild.mockClear()
    mockGetRuntime.mockResolvedValue({ semanticReady: false, rebuilding: false, lastRebuild: null, index: null })
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it('rejects enabling without the automatic-summarization prerequisite', async () => {
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-x')
    // summary.auto is NOT on — enabling must fail and must not rebuild
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { enabled: 'on' }, headers: json })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('Cannot enable semantic search')
    expect(mockRequestRebuild).not.toHaveBeenCalled()
  })

  it('rejects enabling when the openai credential is missing', async () => {
    seedPrerequisite()
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { enabled: 'on', provider: 'openai', model: 'text-embedding-3-small' }, headers: json })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/API key is required/)
    expect(mockRequestRebuild).not.toHaveBeenCalled()
  })

  it('enables embeddings when the prerequisite is met and rebuilds the index (no duplicate rebuilds)', async () => {
    seedPrerequisite()
    upsertSetting('embedding.api_key', 'sk-embedding')
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { enabled: 'on', provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 }, headers: json })
    expect(res.statusCode).toBe(200)
    expect(res.json().enabled).toBe('on')
    expect(getSetting('embedding.enabled')).toBe('on')
    expect(getSetting('embedding.provider')).toBe('openai')
    expect(mockRequestRebuild).toHaveBeenCalledTimes(1)
  })

  it('disabling embeds is allowed and rebuilds into keyword-only', async () => {
    seedPrerequisite()
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk')

    const res = await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { enabled: 'off' }, headers: json })
    expect(res.statusCode).toBe(200)
    expect(res.json().enabled).toBe('off')
    expect(mockRequestRebuild).toHaveBeenCalledTimes(1)
  })

  it('rebuilds when provider/model change while enabled but not for no-op patches', async () => {
    seedPrerequisite()
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk')

    await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { model: 'text-embedding-3-large' }, headers: json })
    expect(mockRequestRebuild).toHaveBeenCalledTimes(1)

    // Same value again → no rebuild
    await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { model: 'text-embedding-3-large' }, headers: json })
    expect(mockRequestRebuild).toHaveBeenCalledTimes(1)
  })

  it('rejects configuration changes while a rebuild is active', async () => {
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    mockIsRebuilding.mockReturnValueOnce(true)

    const res = await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { model: 'text-embedding-3-large' }, headers: json })
    expect(res.statusCode).toBe(409)
    expect(getSetting('embedding.model')).toBe('text-embedding-3-small')
    expect(mockRequestRebuild).not.toHaveBeenCalled()
  })

  it('validates provider, dimensions and base_url', async () => {
    let res = await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { provider: 'nope' }, headers: json })
    expect(res.statusCode).toBe(400)

    res = await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { dimensions: '0' }, headers: json })
    expect(res.statusCode).toBe(400)

    res = await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { provider: 'openai', base_url: 'http://example.com/v1' }, headers: json })
    expect(res.statusCode).toBe(400)

    res = await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { provider: 'ollama', base_url: 'http://localhost:11434' }, headers: json })
    expect(res.statusCode).toBe(200)

    res = await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { base_url: 'https://192.168.1.1' }, headers: json })
    expect(res.statusCode).toBe(400)
  })

  it('validates a retained base URL when switching providers', async () => {
    upsertSetting('embedding.provider', 'ollama')
    upsertSetting('embedding.model', 'nomic-embed-text')
    upsertSetting('embedding.base_url', 'http://ollama:11434')
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/search-embedding', payload: { provider: 'openai' }, headers: json })
    expect(res.statusCode).toBe(400)
    expect(getSetting('embedding.provider')).toBe('ollama')
  })
})

describe('POST /api/settings/search-embedding/key', () => {
  beforeEach(async () => {
    setupTestDb()
    mockRequestRebuild.mockClear()
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it('stores the credential and never returns it afterwards', async () => {
    seedPrerequisite()
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')

    let res = await app.inject({ method: 'POST', url: '/api/settings/search-embedding/key', payload: { apiKey: 'sk-stored-secret' }, headers: json })
    expect(res.statusCode).toBe(200)
    expect(res.json().configured).toBe(true)
    expect(mockRequestRebuild).toHaveBeenCalledTimes(1) // key change while enabled re-syncs the embedder

    res = await app.inject({ method: 'GET', url: '/api/settings/search-embedding' })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('sk-stored-secret')
    expect(res.json().api_key_configured).toBe(true)
  })

  it('deletes the credential on empty key', async () => {
    seedPrerequisite()
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-old')

    const res = await app.inject({ method: 'POST', url: '/api/settings/search-embedding/key', payload: { apiKey: '' }, headers: json })
    expect(res.statusCode).toBe(200)
    expect(res.json().configured).toBe(false)
    expect(getSetting('embedding.api_key')).toBeUndefined()
  })

  it('rebuilds when an existing credential is replaced', async () => {
    seedPrerequisite()
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-old')

    const res = await app.inject({ method: 'POST', url: '/api/settings/search-embedding/key', payload: { apiKey: 'sk-new' }, headers: json })
    expect(res.statusCode).toBe(200)
    expect(getSetting('embedding.api_key')).toBe('sk-new')
    expect(mockRequestRebuild).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/settings/search-embedding/test', () => {
  // The probe runs through the pinned, redirect-validating request helper
  // (node:http), so these tests exercise the real request path against a
  // local HTTP server instead of stubbing global fetch.
  let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    setupTestDb()
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.1) }] }))
    }
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => respond(req, res))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('validates connectivity and reports dimensions', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/settings/search-embedding/test', payload: { provider: 'openai', model: 'text-embedding-3-small', apiKey: 'sk-test', base_url: `${baseUrl}/v1` }, headers: json })
    expect(res.statusCode).toBe(200)
    expect(res.json().dimensions).toBe(1536)
  })

  it('requires a provider and a key for openai', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/settings/search-embedding/test', payload: {} as Record<string, unknown>, headers: json })
    expect(res.statusCode).toBe(400)

    res = await app.inject({ method: 'POST', url: '/api/settings/search-embedding/test', payload: { provider: 'openai', model: 'text-embedding-3-small' }, headers: json })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/API key/)
  })

  it('redacts credentials echoed by an embedding endpoint', async () => {
    respond = (_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('authorization Bearer sk-echoed-secret')
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/search-embedding/test',
      payload: { provider: 'openai', model: 'text-embedding-3-small', apiKey: 'sk-echoed-secret', base_url: `${baseUrl}/v1` },
      headers: json,
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).not.toContain('sk-echoed-secret')
    expect(res.json().error).toContain('[redacted]')
  })
})

describe('POST /api/settings/search-embedding/rebuild', () => {
  beforeEach(async () => {
    setupTestDb()
    mockRequestRebuild.mockClear()
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it('rejects rebuild while disabled', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/settings/search-embedding/rebuild' })
    expect(res.statusCode).toBe(400)
  })

  it('starts a rebuild when enabled and not already rebuilding', async () => {
    seedPrerequisite()
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk')

    const res = await app.inject({ method: 'POST', url: '/api/settings/search-embedding/rebuild' })
    expect(res.statusCode).toBe(200)
    expect(mockRequestRebuild).toHaveBeenCalledTimes(1)
  })

  it('returns 409 while a rebuild is already running (no duplicate concurrent rebuilds)', async () => {
    seedPrerequisite()
    upsertSetting('embedding.enabled', 'on')
    mockIsRebuilding.mockReturnValue(true)
    const res = await app.inject({ method: 'POST', url: '/api/settings/search-embedding/rebuild' })
    expect(res.statusCode).toBe(409)
    expect(mockRequestRebuild).not.toHaveBeenCalled()
  })
})
