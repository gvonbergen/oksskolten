import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb } from '../__tests__/helpers/testDb.js'
import { upsertSetting, deleteSetting } from '../db.js'
import { TASK_DEFAULTS } from '../../shared/models.js'
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
  embeddingConfigFingerprint,
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
    expect(embedder.url).toBe('https://openrouter.ai/api/v1')
    expect(embedder.documentTemplate).toBe(EMBEDDING_TEMPLATE)
    expect(embedder.apiKey).toBe('sk-abc')
    // Only the managed embedder is emitted
    expect(Object.keys(embedders!)).toEqual([EMBEDDER_NAME])
  })

  it('compiles the ollama embedder without a default url and with the model', () => {
    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'ollama')
    upsertSetting('embedding.model', 'nomic-embed-text')

    const embedders = buildEmbeddersSettings(getEmbeddingConfig())
    const embedder = embedders![EMBEDDER_NAME] as Record<string, unknown>
    expect(embedder.source).toBe('ollama')
    expect(embedder.model).toBe('nomic-embed-text')
    expect(embedder.url).toBeUndefined()
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

  it('fingerprint changes only with non-secret configuration', () => {
    const a = embeddingConfigFingerprint(openaiConfig({ apiKey: 'key-a' }))
    const b = embeddingConfigFingerprint(openaiConfig({ apiKey: 'key-b' }))
    expect(a).toBe(b)
    const c = embeddingConfigFingerprint(openaiConfig({ model: 'text-embedding-3-large', dimensions: 3072 }))
    expect(a).not.toBe(c)
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

  it('falls back to the default summary model when none is configured (defaults always apply)', () => {
    upsertSetting('summary.auto', 'on')
    upsertSetting('summary.provider', 'anthropic')
    upsertSetting('api_key.anthropic', 'sk-ant-x')
    deleteSetting('summary.model')
    expect(getEmbeddingPrerequisite().summaryModel).toBe(TASK_DEFAULTS.summarize.model)
    expect(getEmbeddingPrerequisite().met).toBe(true)
  })
})

describe('applyEmbeddingVectors', () => {
  beforeEach(() => {
    setupTestDb()
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

  it('leaves docs untouched when embeddings are disabled', () => {
    const doc = applyEmbeddingVectors({ id: 1, title: 'T', summary: null })
    expect(doc._vectors).toBeUndefined()
  })
})

describe('testEmbeddingConnection', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    setupTestDb()
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('validates an OpenAI-compatible endpoint and reports dimensions', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
    })
    const result = await testEmbeddingConnection(openaiConfig())
    expect(result.ok).toBe(true)
    expect(result.dimensions).toBe(1536)
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toBe('https://api.openai.com/v1/embeddings')
  })

  it('reports provider errors', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'Incorrect API key' })
    const result = await testEmbeddingConnection(openaiConfig())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('401')
  })

  it('flags dimension mismatch', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: new Array(512).fill(0.1) }] }),
    })
    const result = await testEmbeddingConnection(openaiConfig({ dimensions: 1536 }))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/dimension/i)
  })

  it('validates an Ollama endpoint via /api/embed', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [new Array(768).fill(0.1)] }),
    })
    const result = await testEmbeddingConnection({
      enabled: true,
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimensions: null,
      baseUrl: 'http://localhost:11434',
      apiKey: null,
    })
    expect(result.ok).toBe(true)
    expect(result.dimensions).toBe(768)
    expect(mockFetch.mock.calls[0][0] as string).toBe('http://localhost:11434/api/embed')
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