import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { logger } from '../logger.js'

const log = logger.child('embedding-proxy')

const ENV_FILE = path.join(process.cwd(), '.env')

let resolvedToken: string | null = null

/**
 * Token resolution order:
 * 1. explicit EMBEDDING_PROXY_TOKEN environment variable (deployment sets it)
 * 2. an EMBEDDING_PROXY_TOKEN line persisted in .env by a previous start
 * 3. a freshly generated token, persisted to .env so the next start reuses it
 *
 * The full proxy URL (including this token) is written into the Meilisearch
 * embedder settings, so the token must stay stable across restarts — an
 * unstable URL rewrites the embedder on every boot and forces a full,
 * paid re-embedding of the index.
 */
function resolveProxyToken(): string {
  if (resolvedToken) return resolvedToken
  const explicit = process.env.EMBEDDING_PROXY_TOKEN?.trim()
  if (explicit) {
    resolvedToken = explicit
    return resolvedToken
  }
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    // Never touch the developer's .env from a test run.
    resolvedToken = randomBytes(32).toString('hex')
    return resolvedToken
  }
  const persisted = readPersistedToken()
  if (persisted) {
    resolvedToken = persisted
    return resolvedToken
  }
  const generated = randomBytes(32).toString('hex')
  persistToken(generated)
  resolvedToken = generated
  return resolvedToken
}

function readPersistedToken(): string | null {
  try {
    if (!fs.existsSync(ENV_FILE)) return null
    const match = fs.readFileSync(ENV_FILE, 'utf8').match(/^EMBEDDING_PROXY_TOKEN=(\S+)\s*$/m)
    return match?.[1] ?? null
  } catch (err) {
    log.warn('Could not read .env for EMBEDDING_PROXY_TOKEN:', err)
    return null
  }
}

function persistToken(token: string): void {
  try {
    let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : ''
    const line = `EMBEDDING_PROXY_TOKEN=${token}`
    content = /^EMBEDDING_PROXY_TOKEN=/m.test(content)
      ? content.replace(/^EMBEDDING_PROXY_TOKEN=.*$/m, line)
      : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`
    fs.writeFileSync(ENV_FILE, content)
    log.info('Persisted EMBEDDING_PROXY_TOKEN to .env so the embedder URL stays stable across restarts')
  } catch (err) {
    log.warn('Could not persist EMBEDDING_PROXY_TOKEN to .env; set it explicitly to avoid re-embedding on every restart:', err)
  }
}

export function getEmbeddingProxyToken(): string {
  return resolveProxyToken()
}

export function getEmbeddingProxyUrl(): string {
  const base = (process.env.EMBEDDING_PROXY_URL || `http://localhost:${process.env.PORT || '3000'}/api/internal/embedding-proxy`).replace(/\/+$/, '')
  return `${base}/${encodeURIComponent(resolveProxyToken())}`
}

export function isEmbeddingProxyAuthorized(token: unknown): boolean {
  return typeof token === 'string' && token.length > 0 && token === resolveProxyToken()
}
