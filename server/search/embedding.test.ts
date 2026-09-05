import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDb } from '../__tests__/helpers/testDb.js'
import { upsertSetting, deleteSetting } from '../db.js'
import {
  EMBEDDER_NAME,
  EMBEDDING_TEMPLATE,
  SEMANTIC_RATIO,
  getEmbeddingConfig,
  getSemanticStatus,
  buildEmbeddersSettings,
  getEmbeddingPrerequisite,
  isAutoSummaryEnabled,
  isEmbeddingPrerequisiteMet,
  applyEmbeddingVectors,
  matchesExpectedEmbedder,
  testEmbeddingConnection,
  type EmbeddingConfig,
} from './embedding.js'

function openaiConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    enabled: true,
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    baseUrl: null,
    apiKey: 'sk-test-123',
    ...overrides,
  }
}

describe('embedding config compiler', () => {
  beforeEach(() => {
    setupTestDb()
  })

  it('fresh installation has embeddings disabled and no provider', () => {
    const config = getEmbeddingConfig()
    expect(config.enabled).toBe(false)
    expect(config.provider).toBeNull()
    expect(config.model).toBeNull()
    expect(buildEmbeddersSettings(config)).toBeNull()
  })

  it('disabled config compiles to no embedders (keyword-only settings)', () => {
    const settings = buildEmbeddersSettings(getEmbeddingConfig())
    expect(settings).toBeNull()
  })

  it('compiles the openai embedder with model, dimensions, url and template', () => {
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.dimensions', '1536')
    upsertSetting('embedding.api_key', 'sk-abc')
    upsertSetting('embedding.base_url', 'https://openrouter.ai/api/v1')

    const embedders = buildEmbeddersSettings(getEmbeddingConfig())
    expect(embedders).not.toBeNull()
    const embedder = embedders![EMBEDDER_NAME] as Record<string, unknown>
    expect(embedder.source).toBe('openAi')
    expect(embedder.model).toBe('text-embedding-3-small')
    expect(embedder.dimensions).toBe(1536)
    expect(embedder.url).toBeDefined()
    expect(embedder.documentTemplate).toBe(EMBEDDING_TEMPLATE)
    expect(embedder.apiKey).toBe('sk-abc')
    // Only the managed embedder is emitted
    expect(Object.keys(embedders!)).toEqual([EMBEDDER_NAME])
  })

  it('compiles the ollama embedder through the safe proxy with the model', () => {
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'ollama')
    upsertSetting('embedding.model', 'nomic-embed-text')

    const embedders = buildEmbeddersSettings(getEmbeddingConfig())
    const embedder = embedders![EMBEDDER_NAME] as Record<string, unknown>
    expect(embedder.source).toBe('ollama')
    expect(embedder.model).toBe('nomic-embed-text')
    expect(embedder.url).toBeDefined()
    expect(embedder.apiKey).toBeUndefined()
    expect(embedder.documentTemplate).toBe(EMBEDDING_TEMPLATE)
  })

  it('enabled config without a model compiles to no embedders', () => {
    const config = openaiConfig({ model: null })
    expect(buildEmbeddersSettings(config)).toBeNull()
  })

  it('never exposes the secret in status payloads', () => {
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-super-secret')

    const status = getSemanticStatus()
    const json = JSON.stringify(status)
    expect(json).not.toContain('sk-super-secret')
    expect(status.config).not.toHaveProperty('apiKey')
    expect(status.config.apiKeyConfigured).toBe(true)
  })

  it('matchesExpectedEmbedder compares live settings against config, stripping secrets', () => {
    const config = openaiConfig()
    const live = {
      [EMBEDDER_NAME]: {
        source: 'openAi',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        documentTemplate: EMBEDDING_TEMPLATE,
        apiKey: 'sk-different-live-key',
      },
    }
    expect(matchesExpectedEmbedder(live, config)).toBe(true)
    expect(matchesExpectedEmbedder({ [EMBEDDER_NAME]: { source: 'openAi', model: 'wrong-model' } }, config)).toBe(false)
    // Disabled config expects no live embedder
    expect(matchesExpectedEmbedder({ [EMBEDDER_NAME]: { source: 'ollama', model: 'x' } }, openaiConfig({ enabled: false }))).toBe(false)
    expect(matchesExpectedEmbedder(null, openaiConfig({ enabled: false }))).toBe(true)
  })
})

describe('automatic summarization prerequisite', () => {
  beforeEach(() => {
    setupTestDb()
  })

  it('prerequisite is unmet when automatic summarization is off', () => {
    upsertSetting('summary.provider', 'anthropic')
    upsertSetting('summary.model', 'claude-haiku-4-5-20251001')
    upsertSetting('api_key.anthropic', 'sk-ant-x')
    const p = getEmbeddingPrerequisite()
    expect(p.met).toBe(false)
    expect(p.reason).toMatch(/ON/i)
  })

  it('prerequisite is unmet when the summary provider is unconfigured', () => {
    upsertSetting('summary.auto', 'on')
    upsertSetting('summary.provider', 'openai')
    upsertSetting('summary.model', 'gpt-4.1-mini')
    // no api_key.openai
    expect(isEmbeddingPrerequisiteMet()).toBe(false)
    expect(getEmbeddingPrerequisite().reason).toMatch(/API key/i)
    expect(isAutoSummaryEnabled()).toBe(false)
  })

  it('prerequisite is met when auto summarization is configured with a key', () => {
    upsertSetting('summary.auto', 'on')
    upsertSetting('summary.provider', 'openai')
    upsertSetting('summary.model', 'gpt-4.1-mini')
    upsertSetting('api_key.openai', 'sk-openai')
    expect(isEmbeddingPrerequisiteMet()).toBe(true)
    expect(isAutoSummaryEnabled()).toBe(true)
  })

  it('ollama counts as configured without a key', () => {
    upsertSetting('summary.auto', 'on')
    upsertSetting('summary.provider', 'ollama')
    upsertSetting('summary.model', 'llama3.2:latest')
    expect(isEmbeddingPrerequisiteMet()).toBe(true)
  })

  it('claude-code cannot drive the embedding prerequisite (server cannot verify its auth)', () => {
    upsertSetting('summary.auto', 'on')
    upsertSetting('summary.provider', 'claude-code')
    upsertSetting('summary.model', 'claude-haiku-4-5-20251001')
    const p = getEmbeddingPrerequisite()
    expect(p.met).toBe(false)
    expect(p.reason).toContain('claude-code')
  })

  it('requires a model when a summary provider is explicitly selected', () => {
    upsertSetting('summary.auto', 'on')
    upsertSetting('summary.provider', 'openai')
    upsertSetting('api_key.openai', 'sk-openai')
    deleteSetting('summary.model')
    expect(getEmbeddingPrerequisite().summaryModel).toBeNull()
    expect(getEmbeddingPrerequisite().met).toBe(false)
  })
})

describe('applyEmbeddingVectors', () => {
  beforeEach(() => {
    setupTestDb()
    upsertSetting('summary.auto', 'on')
    upsertSetting('summary.provider', 'openai')
    upsertSetting('summary.model', 'gpt-4.1-mini')
    upsertSetting('api_key.openai', 'sk-summary')
  })

  it('adds a null vector marker for un-summarized docs when embeddings are enabled', () => {
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-x')
    const doc = applyEmbeddingVectors({ id: 1, title: 'T', summary: null })
    expect(doc._vectors).toEqual({ [EMBEDDER_NAME]: null })
  })

  it('summarized docs get no _vectors and are embedded from the template', () => {
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-x')
    const doc = applyEmbeddingVectors({ id: 1, title: 'T', summary: 'S' })
    expect(doc._vectors).toBeUndefined()
  })

  it('keeps manually clipped articles out of embeddings even when summarized', () => {
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-x')
    const doc = applyEmbeddingVectors({ id: 1, title: 'T', feed_type: 'clip', summary: 'S' })
    expect(doc._vectors).toEqual({ [EMBEDDER_NAME]: null })
  })

  it('treats whitespace-only summaries as missing', () => {
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-x')
    const doc = applyEmbeddingVectors({ id: 1, title: 'T', summary: '   ' })
    expect(doc._vectors).toEqual({ [EMBEDDER_NAME]: null })
  })

  it('prevents embedding when the summarization prerequisite is lost', () => {
    deleteSetting('summary.auto')
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    upsertSetting('embedding.api_key', 'sk-x')
    const doc = applyEmbeddingVectors({ id: 1, title: 'T', summary: 'S' })
    expect(doc._vectors).toEqual({ [EMBEDDER_NAME]: null })
  })

  it('marks writes as opted out when embeddings are disabled', () => {
    const doc = applyEmbeddingVectors({ id: 1, title: 'T', summary: 'S' })
    expect(doc._vectors).toEqual({ [EMBEDDER_NAME]: null })
  })

  it('marks writes as opted out when the embedding credential is absent', () => {
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'openai')
    upsertSetting('embedding.model', 'text-embedding-3-small')
    deleteSetting('embedding.api_key')
    const doc = applyEmbeddingVectors({ id: 1, title: 'T', summary: 'S' })
    expect(doc._vectors).toEqual({ [EMBEDDER_NAME]: null })
  })
})

describe('testEmbeddingConnection', () => {
  // The probe runs through the pinned, redirect-validating request helper
  // (node:http), so these tests execute the real request path against a
  // local HTTP server instead of stubbing global fetch.
  interface StubRequest { url: string | undefined; headers: http.IncomingHttpHeaders; body: string }
  let requests: StubRequest[]
  let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    setupTestDb()
    requests = []
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.1) }] }))
    }
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
        respond(req, res)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('validates an OpenAI-compatible endpoint and reports dimensions', async () => {
    const result = await testEmbeddingConnection(openaiConfig({ baseUrl: `${baseUrl}/v1`, apiKey: null }))
    expect(result.ok).toBe(true)
    expect(result.dimensions).toBe(1536)
    expect(requests[0].url).toBe('/v1/embeddings')
    const sent = JSON.parse(requests[0].body) as { model: string; input: string }
    expect(sent.model).toBe('text-embedding-3-small')
    expect(typeof sent.input).toBe('string')
  })

  it('sends the bearer credential to OpenAI-compatible endpoints', async () => {
    await testEmbeddingConnection(openaiConfig({ baseUrl: `${baseUrl}/v1` }))
    expect(requests[0].headers.authorization).toBe('Bearer sk-test-123')
  })

  it('reports provider errors', async () => {
    respond = (_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('Incorrect API key')
    }
    const result = await testEmbeddingConnection(openaiConfig({ baseUrl: `${baseUrl}/v1`, apiKey: null }))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('401')
    expect(result.error).toContain('Incorrect API key')
  })

  it('flags dimension mismatch', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ embedding: new Array(512).fill(0.1) }] }))
    }
    const result = await testEmbeddingConnection(openaiConfig({ baseUrl: `${baseUrl}/v1`, apiKey: null }))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/dimension/i)
  })

  it('validates an Ollama endpoint via /api/embed', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ embeddings: [new Array(768).fill(0.1)] }))
    }
    const result = await testEmbeddingConnection({
      enabled: true,
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimensions: null,
      baseUrl,
      apiKey: null,
    })
    expect(result.ok).toBe(true)
    expect(result.dimensions).toBe(768)
    expect(requests[0].url).toBe('/api/embed')
  })

  it('does not send an embedding credential to Ollama', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ embeddings: [new Array(768).fill(0.1)] }))
    }
    await testEmbeddingConnection({
      enabled: true,
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimensions: null,
      baseUrl,
      apiKey: 'sk-openai-secret',
    })
    expect(requests[0].headers).not.toHaveProperty('authorization')
  })

  it('refuses a probe to a private address over HTTP', async () => {
    const result = await testEmbeddingConnection(openaiConfig({ baseUrl: 'http://10.0.0.5:8080/v1', apiKey: null }))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/loopback/i)
  })

  it('requires provider and model', async () => {
    const result = await testEmbeddingConnection(openaiConfig({ provider: null }))
    expect(result.ok).toBe(false)
  })
})

// Keep SEMANTIC_RATIO referenced so the constant is exercised (used by routes)
describe('query constants', () => {
  it('uses a conservative semantic ratio for hybrid search', () => {
    expect(SEMANTIC_RATIO).toBeGreaterThan(0)
    expect(SEMANTIC_RATIO).toBeLessThan(0.5)
  })
})