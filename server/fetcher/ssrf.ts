import { lookup } from 'node:dns/promises'

/**
 * Error thrown when a URL is rejected by the SSRF guard.
 * The message always starts with "Blocked URL:" so callers can distinguish
 * security rejections from ordinary network failures.
 */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlockedUrlError'
  }
}

/** True when the error is an SSRF-guard rejection (must not be retried via FlareSolverr). */
export function isBlockedUrlError(err: unknown): boolean {
  return err instanceof BlockedUrlError ||
    (err instanceof Error && err.message.startsWith('Blocked URL:'))
}

/**
 * Exact-host allowlist for self-hosted / private-network feed sources.
 * Comma-separated hostnames from FEED_URL_ALLOWLIST. Matching is by exact
 * hostname (case-insensitive) — subdomains are NOT covered. Allowlisted hosts
 * skip the private hostname / private IP checks but still must use http(s).
 */
function isHostAllowlisted(hostname: string): boolean {
  const raw = process.env.FEED_URL_ALLOWLIST
  if (!raw) return false
  const host = hostname.toLowerCase()
  return raw
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .some(entry => entry === host)
}

function isPrivateIP(ip: string): boolean {
  // IPv4 private/loopback/link-local ranges
  if (/^127\./.test(ip)) return true
  if (/^10\./.test(ip)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true
  if (/^192\.168\./.test(ip)) return true
  if (/^169\.254\./.test(ip)) return true
  if (ip === '0.0.0.0') return true
  // IPv6 loopback / private
  if (ip === '::1' || ip === '::' || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip)) return true
  return false
}

export async function assertSafeUrl(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedUrlError(`Blocked URL: disallowed protocol ${parsed.protocol}`)
  }
  const hostname = parsed.hostname
  if (isHostAllowlisted(hostname)) return
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new BlockedUrlError(`Blocked URL: private hostname ${hostname}`)
  }
  // If hostname is already an IP literal, check directly
  if (/^[\d.]+$/.test(hostname) || hostname.startsWith('[')) {
    const ip = hostname.replace(/^\[|\]$/g, '')
    if (isPrivateIP(ip)) throw new BlockedUrlError(`Blocked URL: private IP ${ip}`)
    return
  }
  // Resolve DNS and check the resulting IP
  try {
    const { address } = await lookup(hostname)
    if (isPrivateIP(address)) throw new BlockedUrlError(`Blocked URL: ${hostname} resolves to private IP ${address}`)
  } catch (err) {
    if (isBlockedUrlError(err)) throw err
    // DNS resolution failed — let the subsequent fetch handle it
  }
}

const MAX_REDIRECTS = 5
// Only actual redirect statuses per RFC 7231/7538.
// Excludes 300 (Multiple Choices) and 304 (Not Modified).
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  await assertSafeUrl(url)
  let currentUrl = url
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const res = await fetch(currentUrl, { ...init, redirect: 'manual' })
    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location')
      if (!location) throw new Error(`Redirect without Location header from ${currentUrl}`)
      currentUrl = new URL(location, currentUrl).href
      await assertSafeUrl(currentUrl)
      continue
    }
    return res
  }
  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`)
}
