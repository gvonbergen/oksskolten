const EMBEDDING_PROXY_PREFIX = '/api/internal/embedding-proxy/'

/**
 * Shared rate-limit allow-list policy. Only non-API URLs (health, assets)
 * and the token-authenticated internal embedding-proxy route are exempt:
 * Meilisearch drives one proxy request per embedding batch during indexing,
 * which far exceeds the public per-IP budget. All public API routes keep
 * their rate limit; the proxy route still rejects invalid tokens.
 */
export function isRateLimitExempt(url: string | undefined): boolean {
  if (!url) return false
  return !url.startsWith('/api') || url.startsWith(EMBEDDING_PROXY_PREFIX)
}
