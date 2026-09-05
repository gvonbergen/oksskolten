import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { embeddingProxyRoutes } from './embedding-proxy.js'
import { isRateLimitExempt } from '../rate-limit.js'
import { setupTestDb } from '../__tests__/helpers/testDb.js'
import { upsertSetting } from '../db.js'
import { getEmbeddingProxyToken } from '../search/proxy-config.js'

const apps: FastifyInstance[] = []

async function buildLimitedApp() {
  const app = Fastify()
  await app.register(rateLimit, {
    max: 3,
    timeWindow: '1 minute',
    allowList: (req) => isRateLimitExempt(req.url),
  })
  app.get('/api/ping', async () => ({ pong: true }))
  app.get('/api/internal/other', async () => ({ ok: true }))
  await app.register(embeddingProxyRoutes)
  apps.push(app)
  return app
}

afterAll(async () => {
  await Promise.all(apps.map(app => app.close()))
})

describe('embedding proxy rate limiting', () => {
  it('keeps the per-IP limit on public API routes', async () => {
    const app = await buildLimitedApp()
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      statuses.push((await app.inject({ method: 'GET', url: '/api/ping' })).statusCode)
    }
    expect(statuses.filter(code => code === 200)).toHaveLength(3)
    expect(statuses.filter(code => code === 429)).toHaveLength(2)
  })

  it('exempts the proxy path from the per-IP limit but still rejects bad tokens', async () => {
    const app = await buildLimitedApp()
    const statuses: number[] = []
    for (let i = 0; i < 10; i++) {
      statuses.push((await app.inject({ method: 'POST', url: '/api/internal/embedding-proxy/not-the-token/embeddings' })).statusCode)
    }
    // Ten requests exceed max: 3 — a 429 here would mean the exemption is
    // not applied to the proxy path.
    expect(statuses.every(code => code === 401)).toBe(true)
  })

  it('does not exempt similar non-proxy /api paths', async () => {
    const app = await buildLimitedApp()
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      statuses.push((await app.inject({ method: 'GET', url: '/api/internal/other' })).statusCode)
    }
    expect(statuses.filter(code => code === 200)).toHaveLength(3)
    expect(statuses.filter(code => code === 429)).toHaveLength(2)
  })
})

describe('embedding proxy endpoint forwarding', () => {
  let app: FastifyInstance
  let upstream: http.Server
  const received: Array<{ url: string | undefined; body: string }> = []

  beforeEach(() => {
    setupTestDb()
    received.length = 0
  })

  afterEach(async () => {
    await Promise.all([
      app?.close(),
      new Promise<void>(resolve => upstream?.close(() => resolve())),
    ])
  })

  async function buildOllamaApp(): Promise<FastifyInstance> {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        received.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ embeddings: [new Array(768).fill(0.1)] }))
      })
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const port = (upstream.address() as AddressInfo).port

    upsertSetting('embedding.enabled', 'on')
    upsertSetting('embedding.provider', 'ollama')
    upsertSetting('embedding.model', 'nomic-embed-text')
    upsertSetting('embedding.base_url', `http://127.0.0.1:${port}`)

    const instance = Fastify()
    await instance.register(embeddingProxyRoutes)
    return instance
  }

  it('forwards Ollama embedder requests to the Ollama /api/embed endpoint', async () => {
    app = await buildOllamaApp()
    const token = getEmbeddingProxyToken()
    const res = await app.inject({
      method: 'POST',
      url: `/api/internal/embedding-proxy/${encodeURIComponent(token)}/api/embed`,
      payload: { model: 'nomic-embed-text', input: ['hello'] },
    })
    expect(res.statusCode).toBe(200)
    expect(received).toHaveLength(1)
    // The Ollama native embedding endpoint is /api/embed — not the
    // OpenAI-style /embeddings and not /api/embeddings.
    expect(received[0].url).toBe('/api/embed')
    const sent = JSON.parse(received[0].body) as { model: string; input: string[] }
    expect(sent.model).toBe('nomic-embed-text')
    expect(JSON.parse(res.body)).toEqual({ embeddings: [new Array(768).fill(0.1)] })
  })

  it('rejects OpenAI-style proxy paths for the Ollama provider', async () => {
    app = await buildOllamaApp()
    const token = getEmbeddingProxyToken()
    for (const path of ['embeddings', 'api/embeddings']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/internal/embedding-proxy/${encodeURIComponent(token)}/${path}`,
        payload: { model: 'nomic-embed-text', input: ['hello'] },
      })
      expect(res.statusCode).toBe(404)
    }
    expect(received).toHaveLength(0)
  })
})
