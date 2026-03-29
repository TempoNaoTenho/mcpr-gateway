import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverJwksUri } from '../../src/auth/oauth-discovery.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('discoverJwksUri', () => {
  it('returns jwks_uri from OpenID discovery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url)
        if (u.endsWith('/.well-known/openid-configuration')) {
          return new Response(JSON.stringify({ jwks_uri: 'https://idp/jwks' }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      }),
    )
    await expect(discoverJwksUri('https://idp/')).resolves.toBe('https://idp/jwks')
  })

  it('falls back to oauth-authorization-server metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url)
        if (u.includes('openid-configuration')) {
          return new Response('{}', { status: 200 })
        }
        if (u.includes('oauth-authorization-server')) {
          return new Response(JSON.stringify({ jwks_uri: 'https://as/jwks2' }), { status: 200 })
        }
        return new Response('no', { status: 404 })
      }),
    )
    await expect(discoverJwksUri('https://as')).resolves.toBe('https://as/jwks2')
  })

  it('falls back to /.well-known/jwks.json when discovery has no jwks_uri', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    )
    await expect(discoverJwksUri('https://issuer')).resolves.toBe('https://issuer/.well-known/jwks.json')
  })
})
