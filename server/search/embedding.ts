import type { Embedders } from 'meilisearch'
import { getSetting } from '../db/settings.js'
import {
  TASK_DEFAULTS,
  getModelValues,
  EMBEDDING_PROVIDERS,
  type EmbeddingProvider,
} from '../../shared/models.js'

/**
 * Embedding-assisted search configuration.
 *
 * The embedder is first-class managed index configuration: the same
 * settings object is applied to the staging index during every rebuild,
 * to a freshly created production index, and idempotently to an
 * already-populated production index on startup. This is what keeps an
 * operator's embedder alive across the six-hour rebuild/swap cycle
 * (https://github.com/babarot/oksskolten/issues/117): the embedder never
 * exists only as a manually-applied production setting that a newly
 * created staging index would clobber.
 *
 * Settings are stored in the SQLite settings table like every other
 * preference. The API key is a genuine secret: it is written into the
 * Meilisearch index settings (Meilisearch persists it in its protected
 * data volume so it can call the embedding provider), but it must never
 * be returned to the client.
 */

export const EMBEDDER_NAME = 'article-v1'

/** Embedding input for v1 is title plus summary, never full article text. */
export const EMBEDDING_TEMPLATE = '{{doc.title}}\n\n{{doc.summary}}'

/**
 * Conservative hybrid balance: keyword dominance for exact names, acronyms
 * and quoted terms, while rescuing conceptual / paraphrased queries.
 */
export const SEMANTIC_RATIO = 0.25

export {
  EMBEDDING_PROVIDERS,
  EMBEDDING_DEFAULT_MODELS,
  EMBEDDING_MODELS,
  getEmbeddingModelLabel,
} from '../../shared/models.js'
export type { EmbeddingProvider } from '../../shared/models.js'

// --- Settings keys ---

export const EMBEDDING_SETTING_ENABLED = 'embedding.enabled'
export const EMBEDDING_SETTING_PROVIDER = 'embedding.provider'
export const EMBEDDING_SETTING_MODEL = 'embedding.model'
export const EMBEDDING_SETTING_DIMENSIONS = 'embedding.dimensions'
export const EMBEDDING_SETTING_BASE_URL = 'embedding.base_url'
export const EMBEDDING_SETTING_API_KEY = 'embedding.api_key'

// --- Config ---

export interface EmbeddingConfig {
  enabled: boolean
  provider: EmbeddingProvider | null
  model: string | null
  dimensions: number | null
  baseUrl: string | null
  /** Secret. Never serialize this outside the server process. */
  apiKey: string | null
}

export function getEmbeddingConfig(): EmbeddingConfig {
  const providerRaw = getSetting(EMBEDDING_SETTING_PROVIDER)
  const provider = EMBEDDING_PROVIDERS.includes(providerRaw as EmbeddingProvider)
    ? (providerRaw as EmbeddingProvider)
    : null
  const dimensionsRaw = getSetting(EMBEDDING_SETTING_DIMENSIONS)
  const dimensionsNum = Number(dimensionsRaw)
  const dimensions =
    dimensionsRaw && Number.isFinite(dimensionsNum) && dimensionsNum >= 1 ? Math.floor(dimensionsNum) : null
  return {
    enabled: getSetting(EMBEDDING_SETTING_ENABLED) === 'on',
    provider,
    model: getSetting(EMBEDDING_SETTING_MODEL) || null,
    dimensions,
    baseUrl: getSetting(EMBEDDING_SETTING_BASE_URL) || null,
    apiKey: getSetting(EMBEDDING_SETTING_API_KEY) || null,
  }
}

// --- Automatic summarization prerequisite ---

export interface SummaryProviderModel {
  provider: string
  model: string | null
}

export function isSummaryModelValid(provider: string, model: string): boolean {
  const modelProvider = provider === 'claude-code' ? 'anthropic' : provider
  const knownModels = getModelValues(modelProvider)
  return knownModels.length === 0 || knownModels.includes(model)
}

export function getSummaryProviderModel(readSetting: (key: string) => string | null = getSetting): SummaryProviderModel {
  const configuredProvider = readSetting('summary.provider')
  const provider = configuredProvider || TASK_DEFAULTS.summarize.provider
  const configuredModel = readSetting('summary.model')
  const candidate = configuredModel || (configuredProvider ? null : TASK_DEFAULTS.summarize.model)
  return {
    provider,
    model: candidate && isSummaryModelValid(provider, candidate) ? candidate : null,
  }
}

/** Summary task providers whose configuration the server can verify cheaply. */
const SUMMARY_EMBEDDING_PREREQUISITE_PROVIDERS = ['anthropic', 'gemini', 'openai', 'ollama', 'vllm'] as const

export function isSummaryProviderConfigured(provider: string): boolean {
  switch (provider) {
    case 'anthropic':
    case 'gemini':
    case 'openai':
      return !!getSetting(`api_key.${provider}`)
    case 'ollama':
      // Base URL has a localhost default; no key required.
      return true
    case 'vllm':
      // Base URL has a localhost default; API key is optional.
      return true
    default:
      return false
  }
}

/**
 * True when automatic article summarization is enabled AND configured.
 * "Configured" means a summary provider with a verifiable credential or
 * local service plus a model. claude-code is intentionally excluded: its
 * auth state lives in the `claude` CLI and cannot be verified by the
 * server cheaply, so it cannot drive the embedding pipeline.
 */
export function isAutoSummaryEnabled(): boolean {
  if (getSetting('summary.auto') !== 'on') return false
  const { provider, model } = getSummaryProviderModel()
  if (!model) return false
  if (!(SUMMARY_EMBEDDING_PREREQUISITE_PROVIDERS as readonly string[]).includes(provider)) return false
  return isSummaryProviderConfigured(provider)
}

export interface EmbeddingPrerequisite {
  met: boolean
  autoSummaryEnabled: boolean
  summaryProvider: string | null
  summaryModel: string | null
  /** First unmet condition, when `met` is false. */
  reason: string | null
}

export function getEmbeddingPrerequisite(): EmbeddingPrerequisite {
  const autoSummaryEnabled = getSetting('summary.auto') === 'on'
  const { provider, model } = getSummaryProviderModel()

  if (!autoSummaryEnabled) {
    return {
      met: false,
      autoSummaryEnabled,
      summaryProvider: provider,
      summaryModel: model || null,
      reason: 'Automatic article summarization (Settings > AI Tasks > Summary) must be ON before semantic search can be enabled',
    }
  }
  if (!model) {
    return {
      met: false,
      autoSummaryEnabled,
      summaryProvider: provider,
      summaryModel: null,
      reason: `A valid summary model must be selected for the ${provider} provider before semantic search can be enabled`,
    }
  }
  if (!(SUMMARY_EMBEDDING_PREREQUISITE_PROVIDERS as readonly string[]).includes(provider)) {
    return {
      met: false,
      autoSummaryEnabled,
      summaryProvider: provider,
      summaryModel: model,
      reason: `The summary provider "${provider}" cannot drive semantic search; choose Anthropic, Gemini, OpenAI, Ollama or vLLM`,
    }
  }
  if (!isSummaryProviderConfigured(provider)) {
    return {
      met: false,
      autoSummaryEnabled,
      summaryProvider: provider,
      summaryModel: model,
      reason: 'The configured summary provider requires an API key before semantic search can be enabled',
    }
  }
  return { met: true, autoSummaryEnabled, summaryProvider: provider, summaryModel: model, reason: null }
}

export function isEmbeddingPrerequisiteMet(): boolean {
  return getEmbeddingPrerequisite().met
}

// --- Meilisearch settings compilation ---

/**
 * Compile the managed `embedders` settings object for the current config.
 * Returns null when embeddings are disabled or the config is not
 * actionable, in which case the index must be keyword-only — preserving
 * today's behavior.
 */
export function buildEmbeddersSettings(config: EmbeddingConfig): Embedders {
  if (!config.enabled || !config.provider || !config.model) return null
  if (config.provider === 'openai' && !config.apiKey) return null

  const shared = {
    documentTemplate: EMBEDDING_TEMPLATE,
    ...(config.dimensions != null ? { dimensions: config.dimensions } : {}),
    ...(config.baseUrl ? { url: config.baseUrl } : {}),
    ...(config.provider === 'openai' && config.apiKey ? { apiKey: config.apiKey } : {}),
  }

  if (config.provider === 'openai') {
    return { [EMBEDDER_NAME]: { source: 'openAi', model: config.model, ...shared } }
  }
  return { [EMBEDDER_NAME]: { source: 'ollama', model: config.model, ...shared } }
}

/**
 * Non-secret canonical fingerprint of the embedder configuration. Two
 * configs that embed identically must produce the same fingerprint;
 * changes to the secret must not change it.
 */
export function embeddingConfigFingerprint(config: EmbeddingConfig): string {
  return JSON.stringify({
    name: EMBEDDER_NAME,
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    baseUrl: config.baseUrl,
    template: EMBEDDING_TEMPLATE,
  })
}

/**
 * Compare a live `embedders` object read back from the Meilisearch index
 * against what the current config expects. Secrets are stripped before
 * comparison — the live settings response may contain the persisted API
 * key.
 */
export function matchesExpectedEmbedder(
  live: Record<string, unknown> | null | undefined,
  config: EmbeddingConfig,
): boolean {
  const expected = buildEmbeddersSettings(config)
  if (!expected) return !live || !live[EMBEDDER_NAME]
  const liveEmbedder = live?.[EMBEDDER_NAME] as Record<string, unknown> | undefined
  if (!liveEmbedder) return false
  const expectedEmbedder = expected[EMBEDDER_NAME] as Record<string, unknown>
  for (const key of Object.keys(expectedEmbedder)) {
    if (key === 'apiKey') continue
    if (liveEmbedder[key] !== expectedEmbedder[key]) return false
  }
  // The live embedder must not carry an unexpected required source/model.
  if (liveEmbedder.source !== expectedEmbedder.source) return false
  if (liveEmbedder.model !== expectedEmbedder.model) return false
  return true
}

/**
 * Attach `_vectors` to documents that must not be embedded. Meilisearch
 * treats a null embedder entry as "this document has no embeddings" and
 * skips automatic generation, so we never send title-only vectors for
 * un-summarized articles. Manually clipped articles are always skipped, even
 * if they have a summary. Other summarized documents carry no `_vectors`
 * field and are embedded automatically from the template; a later summary
 * update re-upserts the document and regenerates the vector idempotently.
 */
export function applyEmbeddingVectors<T extends { summary?: string | null; feed_type?: string }>(
  doc: T,
  config: EmbeddingConfig = getEmbeddingConfig(),
): T & { _vectors?: Record<string, null> } {
  if (!buildEmbeddersSettings(config) || !isEmbeddingPrerequisiteMet() || doc.feed_type === 'clip' || !doc.summary?.trim()) {
    return { ...doc, _vectors: { [EMBEDDER_NAME]: null } }
  }
  return doc
}

// --- Readiness + diagnostics (server-internal) ---

export interface SemanticRuntimeStatus {
  config: {
    enabled: boolean
    provider: EmbeddingProvider | null
    model: string | null
    dimensions: number | null
    baseUrl: string | null
    apiKeyConfigured: boolean
  }
  prerequisite: EmbeddingPrerequisite
}

/** Non-secret status payload for the settings API. */
export function getSemanticStatus(): SemanticRuntimeStatus {
  const config = getEmbeddingConfig()
  return {
    config: {
      enabled: config.enabled,
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      baseUrl: config.baseUrl,
      apiKeyConfigured: !!config.apiKey,
    },
    prerequisite: getEmbeddingPrerequisite(),
  }
}

// --- Connectivity validation ---

export interface EmbeddingTestResult {
  ok: boolean
  error?: string
  provider?: EmbeddingProvider
  model?: string
  dimensions?: number
}

/**
 * Verify that the embedding provider actually accepts the configured
 * credential/model and returns vectors of the expected dimension. Called
 * before enabling embeddings and from the Settings UI's “Test connection”
 * button. Sends a single tiny probe, never article content.
 */
export async function testEmbeddingConnection(config: EmbeddingConfig): Promise<EmbeddingTestResult> {
  if (!config.provider || !config.model) {
    return { ok: false, error: 'Provider and model are required' }
  }
  const probe = 'oksskolten embedding connectivity probe'
  const headers: Record<string, string> = { 'content-type': 'application/json' }

  try {
    if (config.provider === 'openai') {
      const base = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
      const openAiHeaders = config.apiKey
        ? { ...headers, authorization: `Bearer ${config.apiKey}` }
        : headers
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: openAiHeaders,
        body: JSON.stringify({ model: config.model, input: probe }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, error: `Embedding request failed (HTTP ${res.status}): ${text.slice(0, 300)}` }
      }
      const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> }
      const dimensions = data.data?.[0]?.embedding?.length
      if (!dimensions) return { ok: false, error: 'Unexpected embedder response: no embedding returned' }
      if (config.dimensions != null && dimensions !== config.dimensions) {
        return { ok: false, error: `Vector dimension mismatch: provider returned ${dimensions}, configured ${config.dimensions}` }
      }
      return { ok: true, provider: config.provider, model: config.model, dimensions }
    }
    if (config.provider === 'ollama') {
      const base = (config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '')
      const res = await fetch(`${base}/api/embed`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.model, input: probe }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, error: `Embedding request failed (HTTP ${res.status}): ${text.slice(0, 300)}` }
      }
      const data = (await res.json()) as { embeddings?: number[][] }
      const dimensions = data.embeddings?.[0]?.length
      if (!dimensions) return { ok: false, error: 'Unexpected embedder response: no embedding returned' }
      if (config.dimensions != null && dimensions !== config.dimensions) {
        return { ok: false, error: `Vector dimension mismatch: provider returned ${dimensions}, configured ${config.dimensions}` }
      }
      return { ok: true, provider: config.provider, model: config.model, dimensions }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
  return { ok: false, error: 'Unknown embedding provider' }
}