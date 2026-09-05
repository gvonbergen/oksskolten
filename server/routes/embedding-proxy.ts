import type { FastifyInstance } from 'fastify'
import { getEmbeddingConfig } from '../search/embedding.js'
import { getOllamaCustomHeaders } from '../providers/llm/ollama.js'
import { isEmbeddingProxyAuthorized } from '../search/proxy-config.js'
import { safeEmbeddingRequest, PROXY_FORWARD_TIMEOUT_MS } from '../search/endpoint-safety.js'

const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1'
const DEFAULT_OLLAMA_URL = 'http://localhost:11434'

function targetUrl(baseUrl: string, path: string): string {
  const target = new URL(baseUrl)
  const basePath = target.pathname.replace(/\/+$/, '')
  target.pathname = `${basePath}/${path.replace(/^\/+/, '')}`
  target.search = ''
  return target.toString()
}

export async function embeddingProxyRoutes(api: FastifyInstance): Promise<void> {
  api.post('/api/internal/embedding-proxy/*', async (request, reply) => {
    const rawPath = (request.params as { '*': string })['*']
    const [token, ...pathParts] = rawPath.split('/')
    if (!isEmbeddingProxyAuthorized(token)) {
      reply.status(401).send({ error: 'Unauthorized' })
      return
    }

    const config = getEmbeddingConfig()
    if (!config.enabled || !config.provider || !config.model) {
      reply.status(409).send({ error: 'Embedding configuration is not active' })
      return
    }

    const path = pathParts.join('/')
    const expectedPath = config.provider === 'openai' ? 'embeddings' : 'api/embed'
    if (path !== expectedPath) {
      reply.status(404).send({ error: 'Unknown embedding endpoint' })
      return
    }

    const body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {})
    // Ollama embeddings reuse the custom headers configured for the Ollama LLM
    // provider; they must never reach the OpenAI-compatible endpoint. The
    // content-type is never overridden by them.
    const headers: Record<string, string> =
      config.provider === 'ollama'
        ? { ...getOllamaCustomHeaders(), 'content-type': 'application/json' }
        : { 'content-type': 'application/json' }
    if (config.provider === 'openai' && config.apiKey) {
      headers.authorization = `Bearer ${config.apiKey}`
    }

    try {
      const baseUrl = config.baseUrl || (config.provider === 'openai' ? DEFAULT_OPENAI_URL : DEFAULT_OLLAMA_URL)
      const response = await safeEmbeddingRequest(targetUrl(baseUrl, expectedPath), body, headers, PROXY_FORWARD_TIMEOUT_MS)
      const contentType = response.headers['content-type']
      if (contentType) reply.header('content-type', contentType)
      reply.status(response.statusCode).send(response.body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reply.status(502).send({ error: `Embedding proxy request failed: ${message}` })
    }
  })
}
