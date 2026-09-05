import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getSetting, upsertSetting, deleteSetting } from '../db.js'
import { requireJson } from '../auth.js'
import { parseOrBadRequest } from '../lib/validation.js'
import {
  EMBEDDING_PROVIDERS,
  EMBEDDING_MODELS,
  EMBEDDING_DEFAULT_MODELS,
  EMBEDDING_SETTING_ENABLED,
  EMBEDDING_SETTING_PROVIDER,
  EMBEDDING_SETTING_MODEL,
  EMBEDDING_SETTING_DIMENSIONS,
  EMBEDDING_SETTING_BASE_URL,
  EMBEDDING_SETTING_API_KEY,
  getEmbeddingConfig,
  getEmbeddingPrerequisite,
  getSemanticStatus,
  resolveEmbeddingConnection,
  testEmbeddingConnection,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from '../search/embedding.js'
import { getSearchIndexRuntime, isRebuilding, requestSearchRebuild } from '../search/sync.js'
import { validateEmbeddingEndpoint } from '../search/endpoint-safety.js'

const EmbeddingPatchBody = z.object({
  enabled: z.enum(['on', 'off'], { error: 'enabled must be "on" or "off"' }).optional(),
  provider: z.enum(EMBEDDING_PROVIDERS, { error: `provider must be one of: ${EMBEDDING_PROVIDERS.join(', ')}` }).optional(),
  model: z.string().min(1, 'model must not be empty').max(200).optional(),
  dimensions: z
    .union([
      z.coerce.number().int('dimensions must be an integer').min(1, 'dimensions must be 1-8192').max(8192),
      z.literal(''),
    ])
    .optional(),
  base_url: z.string().max(500).optional(),
})

const EmbeddingTestBody = z.object({
  provider: z.enum(EMBEDDING_PROVIDERS).optional(),
  model: z.string().max(200).optional(),
  dimensions: z.coerce.number().int().min(1).max(8192).optional(),
  base_url: z.string().max(500).optional(),
  apiKey: z.string().max(1000).optional(),
})

const EmbeddingKeyBody = z.object({
  apiKey: z.string().max(1000).optional(),
})

function redactEmbeddingError(error: string, secrets: (string | null | undefined)[]): string {
  return secrets.reduce<string>((safe, secret) => {
    if (!secret) return safe
    return safe.split(secret).join('[redacted]')
  }, error)
}

function resolveProviderModel(provider: EmbeddingProvider, current: EmbeddingConfig): string {
  if (current.provider === provider && current.model) return current.model
  if (current.model && EMBEDDING_MODELS[provider].some(model => model.value === current.model)) return current.model
  return EMBEDDING_DEFAULT_MODELS[provider]
}

function modelChanged(body: z.infer<typeof EmbeddingPatchBody>, current: EmbeddingConfig): boolean {
  if (body.model === undefined && body.provider === undefined) return false
  const nextModel = body.model ?? (body.provider ? resolveProviderModel(body.provider, current) : current.model)
  return nextModel !== current.model
}

function jsonStatus() {
  const status = getSemanticStatus()
  return {
    enabled: status.config.enabled ? 'on' : 'off',
    provider: status.config.provider,
    model: status.config.model,
    dimensions: status.config.dimensions,
    base_url: status.config.baseUrl,
    api_key_configured: status.config.apiKeyConfigured,
    prerequisite: status.prerequisite,
  }
}

export async function searchEmbeddingRoutes(api: FastifyInstance): Promise<void> {
  // --- Read current configuration and runtime status (never returns the secret) ---
  api.get('/api/settings/search-embedding', async (_request, reply) => {
    const runtime = await getSearchIndexRuntime()
    reply.send({
      ...jsonStatus(),
      semantic_ready: runtime.semanticReady,
      rebuilding: runtime.rebuilding,
      last_rebuild: runtime.lastRebuild,
      index: runtime.index,
    })
  })

  // --- Update non-secret configuration + the enable toggle ---
  api.patch(
    '/api/settings/search-embedding',
    { preHandler: [requireJson] },
    async (request, reply) => {
      const body = parseOrBadRequest(EmbeddingPatchBody, request.body, reply)
      if (!body) return
      if (Object.keys(body).length === 0) {
        reply.status(400).send({ error: 'No fields to update' })
        return
      }

      const current = getEmbeddingConfig()
      const nextProvider = (body.provider ?? current.provider) as EmbeddingProvider | null

      const nextModel = body.model ?? (body.provider ? resolveProviderModel(body.provider, current) : current.model)
      const nextDimensions = body.dimensions === undefined
        ? current.dimensions
        : body.dimensions === ''
          ? null
          : body.dimensions
      const storedBaseUrl = getSetting(EMBEDDING_SETTING_BASE_URL) || null
      const providedBaseUrl = body.base_url === undefined ? undefined : body.base_url.trim() || null
      // base_url is an OpenAI-only override for OpenAI-compatible gateways.
      // Ollama embeddings reuse the base URL (and custom headers) already
      // configured for the Ollama LLM provider — the single source of truth
      // for that provider's connection. A stale stored value is cleaned up
      // when the Ollama provider is selected.
      if (nextProvider === 'ollama' && providedBaseUrl != null) {
        reply.status(400).send({
          error: 'Ollama embeddings reuse the base URL configured for the Ollama provider in Settings > AI Providers; a separate embedding base URL is not used',
        })
        return
      }
      const nextBaseUrl = nextProvider === 'ollama' ? null : (providedBaseUrl === undefined ? storedBaseUrl : providedBaseUrl)
      if (nextBaseUrl !== null) {
        if (!nextProvider) {
          reply.status(400).send({ error: 'Select a provider before configuring base_url' })
          return
        }
        const urlCheck = await validateEmbeddingEndpoint(nextBaseUrl)
        if (!urlCheck.ok) {
          reply.status(400).send({ error: urlCheck.error })
          return
        }
      }
      const enabledChanged = body.enabled !== undefined && body.enabled !== (current.enabled ? 'on' : 'off')
      const providerChanged = body.provider !== undefined && body.provider !== current.provider
      const dimensionsChanged = nextDimensions !== current.dimensions
      const baseUrlChanged = nextBaseUrl !== storedBaseUrl
      const modelWasChanged = modelChanged(body, current)
      const configChanged = enabledChanged || providerChanged || modelWasChanged || dimensionsChanged || baseUrlChanged

      if (isRebuilding() && configChanged) {
        reply.status(409).send({ error: 'An index rebuild is already in progress; retry this configuration change when it finishes' })
        return
      }

      // Enabling is opt-in and guarded: embeddings can only be activated
      // when automatic summarization is configured and enabled, the
      // provider/model are set, and a cloud provider has a credential.
      if (body.enabled === 'on') {
        const prerequisite = getEmbeddingPrerequisite()
        if (!prerequisite.met) {
          reply.status(400).send({ error: `Cannot enable semantic search: ${prerequisite.reason}` })
          return
        }
        if (!nextProvider) {
          reply.status(400).send({ error: 'Select an embedding provider' })
          return
        }
        if (!nextModel) {
          reply.status(400).send({ error: 'Select an embedding model' })
          return
        }
        if (nextProvider === 'openai' && !resolveEmbeddingConnection('openai').apiKey) {
          reply.status(400).send({ error: 'An OpenAI API key is required before enabling semantic search; add it in Settings > AI Providers (OpenAI)' })
          return
        }
      }

      const embedderRelevant: string[] = []
      if (enabledChanged) {
        upsertSetting(EMBEDDING_SETTING_ENABLED, body.enabled!)
        embedderRelevant.push('enabled')
      }
      if (providerChanged) {
        upsertSetting(EMBEDDING_SETTING_PROVIDER, body.provider!)
        embedderRelevant.push('provider')
      }
      if (modelWasChanged) {
        if (nextModel) upsertSetting(EMBEDDING_SETTING_MODEL, nextModel)
        else deleteSetting(EMBEDDING_SETTING_MODEL)
        embedderRelevant.push('model')
      }
      if (dimensionsChanged) {
        if (nextDimensions === null) deleteSetting(EMBEDDING_SETTING_DIMENSIONS)
        else upsertSetting(EMBEDDING_SETTING_DIMENSIONS, String(nextDimensions))
        embedderRelevant.push('dimensions')
      }
      if (baseUrlChanged) {
        if (nextBaseUrl === null) deleteSetting(EMBEDDING_SETTING_BASE_URL)
        else upsertSetting(EMBEDDING_SETTING_BASE_URL, nextBaseUrl)
        embedderRelevant.push('base_url')
      }

      // Embedder-relevant changes are applied to the index through the
      // managed configuration: kick a rebuild (guarded against concurrent
      // runs) so the staging-swap cycle picks up the new embedder settings
      // and re-embeds from title+summary. Rebuild when the feature is or
      // was active — including the disable action, which rebuilds the
      // index keyword-only so no embedder is left behind.
      const wasEnabled = current.enabled
      const willBeEnabled = body.enabled === undefined ? wasEnabled : body.enabled === 'on'
      if (embedderRelevant.length > 0 && (wasEnabled || willBeEnabled)) {
        requestSearchRebuild()
      }

      const runtime = await getSearchIndexRuntime()
      reply.send({
        ...jsonStatus(),
        semantic_ready: runtime.semanticReady,
        rebuilding: runtime.rebuilding,
        last_rebuild: runtime.lastRebuild,
        index: runtime.index,
      })
    },
  )

  // --- Store / clear the embedding credential (never returned to clients) ---
  api.post(
    '/api/settings/search-embedding/key',
    { preHandler: [requireJson] },
    async (request, reply) => {
      const body = parseOrBadRequest(EmbeddingKeyBody, request.body, reply)
      if (!body) return
      const config = getEmbeddingConfig()
      if (!config.provider) {
        reply.status(400).send({ error: 'Select an embedding provider first' })
        return
      }
      const key = (body.apiKey ?? '').trim()
      const previousKey = getSetting(EMBEDDING_SETTING_API_KEY) || ''
      if (isRebuilding() && key !== previousKey) {
        reply.status(409).send({ error: 'An index rebuild is already in progress; retry this credential change when it finishes' })
        return
      }
      // The embedder only changes when the EFFECTIVE credential changes:
      // api_key.openai (reused from the LLM provider section) wins over the
      // legacy embedding.api_key fallback stored here.
      const effectiveKeyBefore = getEmbeddingConfig().apiKey
      if (key === '') {
        deleteSetting(EMBEDDING_SETTING_API_KEY)
      } else {
        upsertSetting(EMBEDDING_SETTING_API_KEY, key)
      }
      if (getEmbeddingConfig().enabled && getEmbeddingConfig().apiKey !== effectiveKeyBefore) {
        // Keep the persisted Meilisearch embedder in sync with the managed
        // configuration (secrets change the embedder settings object).
        requestSearchRebuild()
      }
      reply.send({ ok: true, configured: key !== '' })
    },
  )

  // --- Validate provider/model/credential connectivity against real APIs ---
  api.post(
    '/api/settings/search-embedding/test',
    { preHandler: [requireJson] },
    async (request, reply) => {
      const body = parseOrBadRequest(EmbeddingTestBody, request.body, reply)
      if (!body) return
      const current = getEmbeddingConfig()
      const candidate: EmbeddingConfig = {
        ...current,
        provider: (body.provider ?? current.provider) as EmbeddingProvider | null,
        model: body.model !== undefined && body.model !== '' ? body.model : current.model,
        dimensions: body.dimensions ?? current.dimensions,
        baseUrl: body.base_url !== undefined ? (body.base_url || null) : current.baseUrl,
        apiKey: body.apiKey !== undefined ? (body.apiKey || null) : current.apiKey,
      }
      if (!candidate.provider) {
        reply.status(400).send({ error: 'Select an embedding provider' })
        return
      }
      if (candidate.provider === 'openai' && !candidate.apiKey) {
        reply.status(400).send({ error: 'An API key is required to test the OpenAI embedding provider' })
        return
      }
      if (candidate.baseUrl) {
        const urlCheck = await validateEmbeddingEndpoint(candidate.baseUrl)
        if (!urlCheck.ok) {
          reply.status(400).send({ error: urlCheck.error })
          return
        }
      }
      const result = await testEmbeddingConnection(candidate)
      if (!result.ok) {
        const safeError = redactEmbeddingError(result.error || 'unknown error', [
          candidate.apiKey,
          getSetting(EMBEDDING_SETTING_API_KEY),
        ])
        reply.status(400).send({ error: `Embedding connection test failed: ${safeError}` })
        return
      }
      reply.send(result)
    },
  )

  // --- Explicit backfill / reindex trigger (async) ---
  api.post('/api/settings/search-embedding/rebuild', async (_request, reply) => {
    const config = getEmbeddingConfig()
    if (!config.enabled) {
      reply.status(400).send({ error: 'Semantic search is not enabled' })
      return
    }
    if (isRebuilding()) {
      reply.status(409).send({ error: 'An index rebuild is already in progress' })
      return
    }
    requestSearchRebuild()
    reply.send({ ok: true })
  })
}