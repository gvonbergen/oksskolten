import { describe, it, expect } from 'vitest'
import { validateEmbeddingEndpoint } from './endpoint-safety.js'

describe('validateEmbeddingEndpoint', () => {
  it('accepts a public HTTPS IP-literal endpoint', async () => {
    const result = await validateEmbeddingEndpoint('https://8.8.8.8/v1')
    expect(result).toEqual({ ok: true })
  })

  it('rejects a direct private IPv4 target', async () => {
    const result = await validateEmbeddingEndpoint('https://169.254.169.254/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/private|local/i)
  })

  it('rejects an IPv4-mapped IPv6 metadata target in dotted notation', async () => {
    const result = await validateEmbeddingEndpoint('https://[::ffff:169.254.169.254]/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/private|local/i)
  })

  it('rejects an IPv4-mapped IPv6 metadata target in hex notation', async () => {
    const result = await validateEmbeddingEndpoint('https://[::ffff:a9fe:a9fe]/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/private|local/i)
  })

  it('rejects a mapped private IPv4 target in hex notation', async () => {
    const result = await validateEmbeddingEndpoint('https://[::ffff:0a00:0005]/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/private|local/i)
  })

  it('rejects a NAT64-translated internal target via the well-known prefix', async () => {
    const result = await validateEmbeddingEndpoint('https://[64:ff9b::169.254.169.254]/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/private|local/i)
  })

  it('rejects a NAT64-translated internal target via the local-use prefix', async () => {
    const result = await validateEmbeddingEndpoint('https://[64:ff9b:1::169.254.169.254]/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/private|local/i)
  })

  it('rejects HTTP for non-local hostnames', async () => {
    const result = await validateEmbeddingEndpoint('http://8.8.8.8/v1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/loopback/i)
  })

  it('allows HTTP for loopback', async () => {
    const result = await validateEmbeddingEndpoint('http://127.0.0.1:11434')
    expect(result).toEqual({ ok: true })
  })
})
