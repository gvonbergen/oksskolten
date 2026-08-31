import { describe, it, expect, vi } from 'vitest'

const TOKEN = vi.hoisted(() => {
  const token = 'proxy-token-fixture-0123456789abcdef'
  process.env.EMBEDDING_PROXY_TOKEN = token
  return token
})

import { getEmbeddingProxyUrl, isEmbeddingProxyAuthorized } from './proxy-config.js'

describe('embedding proxy token', () => {
  it('embeds the configured token in the proxy URL and keeps it stable', () => {
    const first = getEmbeddingProxyUrl()
    const second = getEmbeddingProxyUrl()
    expect(first).toBe(second)
    expect(first).toContain(encodeURIComponent(TOKEN))
    expect(first).toMatch(/^http:\/\/localhost:3000\/api\/internal\/embedding-proxy\//)
  })

  it('authorizes only the configured token', () => {
    expect(isEmbeddingProxyAuthorized(TOKEN)).toBe(true)
    expect(isEmbeddingProxyAuthorized('wrong-token')).toBe(false)
    expect(isEmbeddingProxyAuthorized('')).toBe(false)
    expect(isEmbeddingProxyAuthorized(undefined)).toBe(false)
    expect(isEmbeddingProxyAuthorized(null)).toBe(false)
  })
})
