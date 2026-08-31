import { describe, it, expect, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { embeddingProxyRoutes } from './embedding-proxy.js'
import { isRateLimitExempt } from '../rate-limit.js'

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
