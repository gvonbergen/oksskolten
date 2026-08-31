import { randomBytes } from 'node:crypto'

const proxyToken = process.env.EMBEDDING_PROXY_TOKEN || randomBytes(32).toString('hex')

export function getEmbeddingProxyUrl(): string {
  const base = (process.env.EMBEDDING_PROXY_URL || `http://localhost:${process.env.PORT || '3000'}/api/internal/embedding-proxy`).replace(/\/+$/, '')
  return `${base}/${encodeURIComponent(proxyToken)}`
}

export function isEmbeddingProxyAuthorized(token: unknown): boolean {
  return typeof token === 'string' && token.length > 0 && token === proxyToken
}
