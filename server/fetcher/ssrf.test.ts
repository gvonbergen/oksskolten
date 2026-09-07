import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { assertSafeUrl, safeFetch, isBlockedUrlError } from './ssrf.js'

// Mock dns lookup
const mockLookup = vi.fn()
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => mockLookup(...args) }))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  vi.clearAllMocks()
  mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 })
})

const savedAllowlist = process.env.FEED_URL_ALLOWLIST
afterEach(() => {
  if (savedAllowlist === undefined) delete process.env.FEED_URL_ALLOWLIST
  else process.env.FEED_URL_ALLOWLIST = savedAllowlist
})

// ---------------------------------------------------------------------------
// FEED_URL_ALLOWLIST (exact-host opt-out for private-network feed sources)
// ---------------------------------------------------------------------------
describe('FEED_URL_ALLOWLIST', () => {
  it('allows an allowlisted hostname resolving to a private IP (rssify.v7n.ch → 10.8.0.2 shape)', async () => {
    process.env.FEED_URL_ALLOWLIST = 'rssify.v7n.ch'
    mockLookup.mockResolvedValue({ address: '10.8.0.2', family: 4 })
    await expect(assertSafeUrl('https://rssify.v7n.ch/googlenews')).resolves.toBeUndefined()
  })

  it('does not call DNS for an allowlisted hostname', async () => {
    process.env.FEED_URL_ALLOWLIST = 'rssify.v7n.ch'
    mockLookup.mockResolvedValue({ address: '10.8.0.2', family: 4 })
    await assertSafeUrl('https://rssify.v7n.ch/feed')
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('still blocks a non-listed hostname resolving to a private IP', async () => {
    process.env.FEED_URL_ALLOWLIST = 'rssify.v7n.ch'
    mockLookup.mockResolvedValue({ address: '10.8.0.2', family: 4 })
    await expect(assertSafeUrl('https://intranet.example.com/feed')).rejects.toThrow(
      'resolves to private IP 10.8.0.2',
    )
  })

  it('matches exactly — subdomains of an allowlisted host are NOT allowed', async () => {
    process.env.FEED_URL_ALLOWLIST = 'rssify.v7n.ch'
    mockLookup.mockResolvedValue({ address: '10.8.0.2', family: 4 })
    await expect(assertSafeUrl('https://evil.rssify.v7n.ch/feed')).rejects.toThrow(
      'resolves to private IP',
    )
  })

  it('matches hostnames case-insensitively and tolerates whitespace', async () => {
    process.env.FEED_URL_ALLOWLIST = ' RSSIFY.V7N.ch , other.host '
    mockLookup.mockResolvedValue({ address: '192.168.1.5', family: 4 })
    await expect(assertSafeUrl('https://RSSIFY.v7n.ch/googlenews')).resolves.toBeUndefined()
  })

  it('explicitly allowlisting a private hostname is honored (operator opt-in)', async () => {
    process.env.FEED_URL_ALLOWLIST = 'myhost.local'
    await expect(assertSafeUrl('http://myhost.local/feed')).resolves.toBeUndefined()
    // …but without the allowlist the same URL is still blocked
    delete process.env.FEED_URL_ALLOWLIST
    await expect(assertSafeUrl('http://myhost.local/feed')).rejects.toThrow('private hostname')
  })

  it('still rejects non-http(s) protocols even for allowlisted hosts', async () => {
    process.env.FEED_URL_ALLOWLIST = 'rssify.v7n.ch'
    await expect(assertSafeUrl('file://rssify.v7n.ch/feed')).rejects.toThrow('disallowed protocol')
  })

  it('still blocks redirects from an allowlisted host to a private IP', async () => {
    process.env.FEED_URL_ALLOWLIST = 'rssify.v7n.ch'
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 301, headers: { location: 'http://10.8.0.9/admin' } }),
    )
    await expect(safeFetch('https://rssify.v7n.ch/googlenews')).rejects.toThrow('private IP')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('fetches through safeFetch when allowlisted', async () => {
    process.env.FEED_URL_ALLOWLIST = 'rssify.v7n.ch'
    mockLookup.mockResolvedValue({ address: '10.8.0.2', family: 4 })
    mockFetch.mockResolvedValue(new Response('xml', { status: 200 }))
    const res = await safeFetch('https://rssify.v7n.ch/googlenews')
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when FEED_URL_ALLOWLIST is unset', async () => {
    delete process.env.FEED_URL_ALLOWLIST
    mockLookup.mockResolvedValue({ address: '10.8.0.2', family: 4 })
    await expect(assertSafeUrl('https://rssify.v7n.ch/googlenews')).rejects.toThrow(
      'resolves to private IP 10.8.0.2',
    )
  })
})

// ---------------------------------------------------------------------------
// BlockedUrlError classification
// ---------------------------------------------------------------------------
describe('isBlockedUrlError', () => {
  it('recognizes Blocked URL errors by message prefix', async () => {
    const err = new Error('Blocked URL: example.com resolves to private IP 10.0.0.1')
    expect(isBlockedUrlError(err)).toBe(true)
    expect(isBlockedUrlError(new Error('ECONNRESET'))).toBe(false)
    expect(isBlockedUrlError(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// assertSafeUrl
// ---------------------------------------------------------------------------
describe('assertSafeUrl', () => {
  describe('protocol checks', () => {
    it('allows http', async () => {
      await expect(assertSafeUrl('http://example.com')).resolves.toBeUndefined()
    })

    it('allows https', async () => {
      await expect(assertSafeUrl('https://example.com')).resolves.toBeUndefined()
    })

    it('blocks ftp', async () => {
      await expect(assertSafeUrl('ftp://example.com')).rejects.toThrow('disallowed protocol')
    })

    it('blocks file', async () => {
      await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow('disallowed protocol')
    })
  })

  describe('hostname checks', () => {
    it('blocks localhost', async () => {
      await expect(assertSafeUrl('http://localhost')).rejects.toThrow('private hostname')
    })

    it('blocks .local suffix', async () => {
      await expect(assertSafeUrl('http://myhost.local')).rejects.toThrow('private hostname')
    })

    it('blocks .internal suffix', async () => {
      await expect(assertSafeUrl('http://service.internal')).rejects.toThrow('private hostname')
    })
  })

  describe('IP literal checks', () => {
    it.each([
      ['http://127.0.0.1', '127.0.0.1'],
      ['http://10.0.0.1', '10.0.0.1'],
      ['http://172.16.0.1', '172.16.0.1'],
      ['http://172.31.255.255', '172.31.255.255'],
      ['http://192.168.1.1', '192.168.1.1'],
      ['http://169.254.0.1', '169.254.0.1'],
      ['http://0.0.0.0', '0.0.0.0'],
    ])('blocks private IPv4 %s', async (url) => {
      await expect(assertSafeUrl(url)).rejects.toThrow('private IP')
    })

    it('blocks IPv6 loopback [::1]', async () => {
      await expect(assertSafeUrl('http://[::1]')).rejects.toThrow('private IP')
    })

    it('blocks IPv6 fc00::', async () => {
      await expect(assertSafeUrl('http://[fc00::1]')).rejects.toThrow('private IP')
    })

    it('blocks IPv6 fe80:: link-local', async () => {
      await expect(assertSafeUrl('http://[fe80::1]')).rejects.toThrow('private IP')
    })

    it('allows public IPv4', async () => {
      await expect(assertSafeUrl('http://93.184.216.34')).resolves.toBeUndefined()
    })

    it('does not call DNS for IP literals', async () => {
      await assertSafeUrl('http://93.184.216.34')
      expect(mockLookup).not.toHaveBeenCalled()
    })
  })

  describe('DNS resolution checks', () => {
    it('blocks hostname resolving to private IP', async () => {
      mockLookup.mockResolvedValue({ address: '127.0.0.1', family: 4 })
      await expect(assertSafeUrl('http://evil.com')).rejects.toThrow(
        'resolves to private IP',
      )
    })

    it('allows hostname resolving to public IP', async () => {
      mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 })
      await expect(assertSafeUrl('http://example.com')).resolves.toBeUndefined()
    })

    it('tolerates DNS failure (lets fetch handle it)', async () => {
      mockLookup.mockRejectedValue(new Error('ENOTFOUND'))
      await expect(assertSafeUrl('http://nonexistent.example')).resolves.toBeUndefined()
    })
  })

  describe('edge: 172.x boundary', () => {
    it('allows 172.15.x.x (not private)', async () => {
      await expect(assertSafeUrl('http://172.15.0.1')).resolves.toBeUndefined()
    })

    it('blocks 172.16.0.1', async () => {
      await expect(assertSafeUrl('http://172.16.0.1')).rejects.toThrow('private IP')
    })

    it('allows 172.32.0.1 (not private)', async () => {
      await expect(assertSafeUrl('http://172.32.0.1')).resolves.toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// safeFetch
// ---------------------------------------------------------------------------
describe('safeFetch', () => {
  it('fetches a safe URL', async () => {
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }))
    const res = await safeFetch('http://example.com')
    expect(res.status).toBe(200)
  })

  it('rejects private URL without calling fetch', async () => {
    await expect(safeFetch('http://127.0.0.1')).rejects.toThrow('private IP')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('follows safe redirects', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://example.com/page' } }),
      )
      .mockResolvedValueOnce(new Response('final', { status: 200 }))

    const res = await safeFetch('http://example.com')
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('blocks redirect to private IP', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 301, headers: { location: 'http://127.0.0.1/admin' } }),
    )
    await expect(safeFetch('http://example.com')).rejects.toThrow('private IP')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('blocks redirect to private hostname', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://localhost/secret' } }),
    )
    await expect(safeFetch('http://example.com')).rejects.toThrow('private hostname')
  })

  it('throws on redirect without Location header', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 302 }))
    await expect(safeFetch('http://example.com')).rejects.toThrow('Redirect without Location')
  })

  it('throws after too many redirects', async () => {
    mockFetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://example.com/loop' } }),
    )
    await expect(safeFetch('http://example.com')).rejects.toThrow('Too many redirects')
    expect(mockFetch).toHaveBeenCalledTimes(5)
  })

  it('passes init options through to fetch', async () => {
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }))
    const signal = AbortSignal.timeout(5000)
    await safeFetch('http://example.com', { headers: { 'X-Test': '1' }, signal })
    expect(mockFetch).toHaveBeenCalledWith(
      'http://example.com',
      expect.objectContaining({ headers: { 'X-Test': '1' }, signal, redirect: 'manual' }),
    )
  })

  it('passes through 304 Not Modified without treating it as a redirect', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 304 }))
    const res = await safeFetch('http://example.com')
    expect(res.status).toBe(304)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('passes through 300 Multiple Choices without treating it as a redirect', async () => {
    mockFetch.mockResolvedValueOnce(new Response('choices', { status: 300 }))
    const res = await safeFetch('http://example.com')
    expect(res.status).toBe(300)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('validates each hop in a redirect chain', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://hop2.com' } }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://hop3.com' } }),
      )
      .mockResolvedValueOnce(new Response('done', { status: 200 }))

    const res = await safeFetch('http://hop1.com')
    expect(res.status).toBe(200)
    expect(mockLookup).toHaveBeenCalledTimes(3) // hop1, hop2, hop3
  })
})
