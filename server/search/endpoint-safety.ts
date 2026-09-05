import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type SafeEndpointResult = {
  ok: true
} | {
  ok: false
  error: string
}

function ipv4Number(address: string): number | null {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
}

function ipv6Number(address: string): bigint | null {
  const embedded = address.toLowerCase().match(/(.*):((?:\d+\.){3}\d+)$/)
  let expanded = address.toLowerCase()
  if (embedded) {
    // Each dotted part is a single byte; two bytes form one 16-bit hex group.
    const bytes = embedded[2].split('.').map(Number)
    if (bytes.length !== 4 || bytes.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
    const groups = [0, 2].map(i => ((bytes[i] << 8) | bytes[i + 1]).toString(16).padStart(4, '0'))
    expanded = `${embedded[1]}:${groups.join(':')}`
  }
  const sections = expanded.split('::')
  if (sections.length > 2) return null
  const left = sections[0] ? sections[0].split(':') : []
  const right = sections.length === 2 && sections[1] ? sections[1].split(':') : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || (sections.length === 1 && missing !== 0)) return null
  const groups = [...left, ...Array(missing).fill('0'), ...right]
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n)
}

function inCidr(address: string, network: string, bits: number): boolean {
  const version = isIP(address)
  if (version !== isIP(network)) return false
  if (version === 4) {
    const value = ipv4Number(address)
    const base = ipv4Number(network)
    if (value === null || base === null) return false
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (value & mask) === (base & mask)
  }
  const value = ipv6Number(address)
  const base = ipv6Number(network)
  if (value === null || base === null) return false
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits)
  return (value & mask) === (base & mask)
}

function isUnsafeAddress(address: string): boolean {
  if (isIP(address) === 6) {
    // Normalize IPv4-mapped IPv6 (::ffff:0:0/96) in both dotted and hex
    // notation to its IPv4 form so mapped internal targets like
    // [::ffff:a9fe:a9fe] (169.254.169.254) are classified, and rejected,
    // by the IPv4 rules instead of being pinned literally.
    const value = ipv6Number(address)
    if (value !== null && (value >> 32n) === 0xffffn) {
      const v4 = value & 0xffffffffn
      return isUnsafeAddress(
        `${(v4 >> 24n) & 0xffn}.${(v4 >> 16n) & 0xffn}.${(v4 >> 8n) & 0xffn}.${v4 & 0xffn}`,
      )
    }
  }
  if (isIP(address) === 4) {
    // RFC1918 private ranges (10/8, 172.16/12, 192.168/16) are deliberately
    // NOT listed: the base URL is operator-chosen and authenticated, and a
    // self-hosted embedder commonly lives on the LAN or a VPN (10.8.0.1,
    // 192.168.x.x, the Docker bridge gateway). Everything else that makes
    // no sense as a provider endpoint stays rejected.
    return [
      ['0.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([network, bits]) => inCidr(address, network as string, bits as number))
  }
  // IPv6: ULA (fc00::/7) is the private-LAN equivalent of RFC1918 and is
  // allowed for the same reason; link-local, multicast and documentation
  // ranges stay rejected.
  return [
    ['::', 128], ['::1', 128], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
    ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ].some(([network, bits]) => inCidr(address, network as string, bits as number))
}

/**
 * Operator-facing private network targets: RFC1918 for IPv4 and ULA for
 * IPv6. These are allowed as embedding endpoints (and over plaintext HTTP,
 * since the traffic never leaves a trusted segment).
 */
function isPrivateLanAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return inCidr(address, '10.0.0.0', 8) || inCidr(address, '172.16.0.0', 12) || inCidr(address, '192.168.0.0', 16)
  }
  if (isIP(address) === 6) return inCidr(address, 'fc00::', 7)
  return false
}

function isPrivateLanLiteral(hostname: string): boolean {
  return (isIP(hostname) === 4 || isIP(hostname) === 6) && isPrivateLanAddress(hostname)
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

function isLocalEndpoint(hostname: string): boolean {
  return hostname === 'localhost' || hostname === 'host.docker.internal' ||
    (isIP(hostname) === 4 && inCidr(hostname, '127.0.0.0', 8)) ||
    (isIP(hostname) === 6 && inCidr(hostname, '::1', 128))
}

async function safeAddresses(url: URL): Promise<string[]> {
  const hostname = hostnameOf(url)
  if (url.username || url.password) throw new Error('base_url must not contain credentials')
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('base_url must use http:// or https://')
  let addresses: string[]
  if (isIP(hostname)) {
    addresses = [hostname]
  } else {
    addresses = (await lookup(hostname, { all: true, verbatim: true })).map(result => result.address)
  }
  if (addresses.length === 0) throw new Error('base_url hostname could not be resolved safely')
  // Loopback metadata services, link-local, multicast and reserved ranges
  // stay off limits even though the base URL is operator-chosen.
  if (!isLocalEndpoint(hostname) && addresses.some(isUnsafeAddress)) {
    throw new Error('base_url must not resolve to a loopback, link-local, multicast, or reserved address')
  }
  // Plaintext HTTP is meaningful only where the traffic never crosses an
  // untrusted segment: loopback / host.docker.internal, a private LAN
  // literal (e.g. http://10.8.0.1:11434), or a hostname resolving
  // exclusively to private LAN addresses. Public hostnames must use HTTPS.
  const plainHttpAllowed = isLocalEndpoint(hostname) ||
    isPrivateLanLiteral(hostname) ||
    (addresses.length > 0 && addresses.every(isPrivateLanAddress))
  if (url.protocol === 'http:' && !plainHttpAllowed) {
    throw new Error('HTTP base_url is allowed only for loopback, host.docker.internal, or private LAN addresses')
  }
  return addresses
}

export async function validateEmbeddingEndpoint(raw: string): Promise<SafeEndpointResult> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'base_url must be a valid absolute URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'base_url must use http:// or https://' }
  }
  if (url.username || url.password) {
    return { ok: false, error: 'base_url must not contain credentials' }
  }
  try {
    await safeAddresses(url)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

interface SafeResponse {
  statusCode: number
  headers: Record<string, string>
  body: Buffer
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

// Short default for the one-shot connectivity probe. Proxied forwarding of
// Meilisearch embedding requests needs far more headroom: local Ollama
// computes an entire /api/embed batch before emitting the first response
// byte, so the probe timeout would 502 every document-embedding task and
// abort every rebuild. Matches MEILI_TASK_TIMEOUT_MS.
const PROBE_TIMEOUT_MS = 10_000
export const PROXY_FORWARD_TIMEOUT_MS = 300_000

function requestPinned(
  url: URL,
  address: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<SafeResponse> {
  const request = url.protocol === 'https:' ? https.request : http.request
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: address,
      port: url.port || undefined,
      method: 'POST',
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, host: url.host, 'content-length': Buffer.byteLength(body).toString() },
      ...(url.protocol === 'https:' ? { servername: hostnameOf(url) } : {}),
    }, response => {
      const chunks: Buffer[] = []
      let received = 0
      response.on('data', chunk => {
        received += chunk.length
        if (received > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`Embedding endpoint response exceeded the ${MAX_RESPONSE_BYTES}-byte limit`))
          return
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      response.on('end', () => {
        const responseHeaders: Record<string, string> = {}
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') responseHeaders[key] = value
          else if (Array.isArray(value)) responseHeaders[key] = value[0] || ''
        }
        resolve({ statusCode: response.statusCode || 502, headers: responseHeaders, body: Buffer.concat(chunks) })
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Embedding endpoint request timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

export async function safeEmbeddingRequest(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<SafeResponse> {
  let url = new URL(rawUrl)
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt++) {
    const addresses = await safeAddresses(url)
    // Every returned address has already been validated as safe, so trying
    // them in order is purely an availability win: a host that publishes
    // several safe addresses (e.g. localhost resolving to ::1 and 127.0.0.1
    // while the service binds IPv4 only) must not fail on the first one.
    let response: SafeResponse | null = null
    let lastError: unknown = null
    for (const address of addresses) {
      try {
        response = await requestPinned(url, address, body, headers, timeoutMs)
        break
      } catch (err) {
        lastError = err
      }
    }
    if (!response) {
      throw lastError instanceof Error
        ? lastError
        : new Error('Embedding endpoint request failed')
    }
    if (!REDIRECT_STATUSES.has(response.statusCode)) return response
    const location = response.headers.location
    if (!location) throw new Error('Embedding endpoint redirect had no Location header')
    if (response.statusCode !== 307 && response.statusCode !== 308) {
      throw new Error('Embedding endpoint returned an unsupported redirect')
    }
    const nextUrl = new URL(location, url)
    if (hostnameOf(nextUrl) !== hostnameOf(url)) {
      throw new Error('Embedding endpoint redirect changed host')
    }
    url = nextUrl
  }
  throw new Error(`Embedding endpoint exceeded the ${MAX_REDIRECTS}-redirect limit`)
}
