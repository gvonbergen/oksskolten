import { describe, it, expect } from 'vitest'
import { validateEmbeddingEndpoint } from './endpoint-safety.js'

describe('validateEmbeddingEndpoint', () => {
  it('accepts a public HTTPS IP-literal endpoint', async () => {
    const result = await validateEmbeddingEndpoint('https://8.8.8.8/v1')
    expect(result).toEqual({ ok: true })
  })

  it('accepts an operator LAN endpoint over HTTPS (RFC1918)', async () => {
    const result = await validateEmbeddingEndpoint('https://10.8.0.1/v1')
    expect(result).toEqual({ ok: true })
  })

  it('accepts a LAN endpoint over plaintext HTTP (self-hosted embedders are plain HTTP)', async () => {
    const result = await validateEmbeddingEndpoint('http://10.8.0.1:11434')
    expect(result).toEqual({ ok: true })
  })

  it('accepts other RFC1918 ranges over plaintext HTTP', async () => {
    expect(await validateEmbeddingEndpoint('http://192.168.1.50:11434')).toEqual({ ok: true })
    expect(await validateEmbeddingEndpoint('http://172.16.0.9:8000')).toEqual({ ok: true })
  })

  it('accepts the Docker bridge gateway as the container host', async () => {
    const result = await validateEmbeddingEndpoint('http://172.17.0.1:11434')
    expect(result).toEqual({ ok: true })
  })

  it('accepts an IPv6 ULA endpoint (the IPv6 private-LAN equivalent)', async () => {
    const result = await validateEmbeddingEndpoint('http://[fc00::1]:11434')
    expect(result).toEqual({ ok: true })
  })

  it('rejects a direct link-local metadata target', async () => {
    const result = await validateEmbeddingEndpoint('https://169.254.169.254/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/loopback|link-local|reserved/i)
  })

  it('rejects a link-local target over plaintext HTTP', async () => {
    const result = await validateEmbeddingEndpoint('http://169.254.169.254/latest/meta-data')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/loopback|link-local|reserved/i)
  })

  it('rejects a link-local IPv6 target', async () => {
    const result = await validateEmbeddingEndpoint('https://[fe80::1]/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/loopback|link-local|reserved/i)
  })

  it('rejects the CGNAT shared range (not an operator LAN)', async () => {
    const result = await validateEmbeddingEndpoint('https://100.64.1.1/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/loopback|link-local|reserved/i)
  })

  it('rejects bogon and reserved ranges', async () => {
    for (const url of ['https://0.0.0.0/v1', 'https://198.18.0.5/v1', 'https://203.0.113.7/v1', 'https://224.0.0.1/v1', 'https://240.0.0.1/v1']) {
      const result = await validateEmbeddingEndpoint(url)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/loopback|link-local|reserved/i)
    }
  })

  it('rejects a mapped loopback target in hex notation', async () => {
    const result = await validateEmbeddingEndpoint('https://[::ffff:7f00:0001]/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/loopback|link-local|reserved/i)
  })

  it('rejects an IPv4-mapped IPv6 metadata target in dotted notation', async () => {
    const result = await validateEmbeddingEndpoint('https://[::ffff:169.254.169.254]/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/loopback|link-local|reserved/i)
  })

  it('rejects an IPv4-mapped IPv6 metadata target in hex notation', async () => {
    const result = await validateEmbeddingEndpoint('https://[::ffff:a9fe:a9fe]/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/loopback|link-local|reserved/i)
  })

  it('rejects a NAT64-translated internal target via the well-known prefix', async () => {
    const result = await validateEmbeddingEndpoint('https://[64:ff9b::169.254.169.254]/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/loopback|link-local|reserved/i)
  })

  it('rejects a NAT64-translated internal target via the local-use prefix', async () => {
    const result = await validateEmbeddingEndpoint('https://[64:ff9b:1::169.254.169.254]/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/loopback|link-local|reserved/i)
  })

  it('rejects HTTP for public hostnames', async () => {
    const result = await validateEmbeddingEndpoint('http://8.8.8.8/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/loopback/i)
  })

  it('allows HTTP for loopback', async () => {
    const result = await validateEmbeddingEndpoint('http://127.0.0.1:11434')
    expect(result).toEqual({ ok: true })
  })

  it('rejects credentials embedded in the URL', async () => {
    const result = await validateEmbeddingEndpoint('http://user:pass@10.8.0.1:11434')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/credentials/i)
  })
})
