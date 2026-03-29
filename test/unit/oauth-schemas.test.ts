import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InboundOAuthSchema, isLoopbackHttpPublicBaseUrl } from '../../src/config/oauth-schemas.js'

describe('isLoopbackHttpPublicBaseUrl', () => {
  it('is true for http loopback origins (with optional port)', () => {
    expect(isLoopbackHttpPublicBaseUrl('http://localhost')).toBe(true)
    expect(isLoopbackHttpPublicBaseUrl('http://localhost:8787/mcp')).toBe(true)
    expect(isLoopbackHttpPublicBaseUrl('http://127.0.0.1:3000')).toBe(true)
    expect(isLoopbackHttpPublicBaseUrl('http://[::1]:8080/')).toBe(true)
    expect(isLoopbackHttpPublicBaseUrl('http://[::ffff:127.0.0.1]:4000/')).toBe(true)
  })

  it('is false for https or non-loopback http', () => {
    expect(isLoopbackHttpPublicBaseUrl('https://localhost')).toBe(false)
    expect(isLoopbackHttpPublicBaseUrl('http://example.com')).toBe(false)
    expect(isLoopbackHttpPublicBaseUrl('http://127.0.0.2')).toBe(false)
  })
})

describe('InboundOAuthSchema production publicBaseUrl', () => {
  const prevEnv = process.env.NODE_ENV

  beforeEach(() => {
    process.env.NODE_ENV = 'production'
  })

  afterEach(() => {
    process.env.NODE_ENV = prevEnv
  })

  it('allows http loopback publicBaseUrl for embedded OAuth', () => {
    const r = InboundOAuthSchema.safeParse({
      publicBaseUrl: 'http://localhost:8787',
      authorizationServers: [],
    })
    expect(r.success).toBe(true)
  })

  it('allows http loopback publicBaseUrl for external OAuth', () => {
    const r = InboundOAuthSchema.safeParse({
      provider: 'external',
      publicBaseUrl: 'http://127.0.0.1:3000',
      authorizationServers: [{ issuer: 'https://idp.example' }],
    })
    expect(r.success).toBe(true)
  })

  it('rejects http non-loopback publicBaseUrl in production (embedded)', () => {
    const r = InboundOAuthSchema.safeParse({
      publicBaseUrl: 'http://gateway.lan',
      authorizationServers: [],
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('https://'))).toBe(true)
    }
  })

  it('rejects http non-loopback publicBaseUrl in production (external)', () => {
    const r = InboundOAuthSchema.safeParse({
      provider: 'external',
      publicBaseUrl: 'http://insecure.example',
      authorizationServers: [{ issuer: 'https://idp.example' }],
    })
    expect(r.success).toBe(false)
  })
})
