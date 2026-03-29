import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAuthorizationServerMetadataDocument,
  getOpenIdConfigurationDocument,
  resetInboundIssuerMetadataCache,
} from '../../src/auth/oauth-issuer-metadata.js'

const oauth = {
  publicBaseUrl: 'https://gw.example.com',
  authorizationServers: [{ issuer: 'https://issuer.example.com', rolesClaim: 'roles' }],
  scopesSupported: ['openid', 'profile'],
}

afterEach(() => {
  resetInboundIssuerMetadataCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('oauth issuer metadata proxy', () => {
  it('builds authorization server metadata from OAuth discovery and adds resource for namespace routes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const value = String(url)
        if (value === 'https://issuer.example.com/.well-known/oauth-authorization-server') {
          return new Response(
            JSON.stringify({
              issuer: 'https://issuer.example.com',
              authorization_endpoint: 'https://issuer.example.com/oauth2/authorize',
              token_endpoint: 'https://issuer.example.com/oauth2/token',
              jwks_uri: 'https://issuer.example.com/oauth2/jwks',
              response_types_supported: ['code'],
            }),
            { status: 200 },
          )
        }
        if (value === 'https://issuer.example.com/.well-known/openid-configuration') {
          return new Response('not found', { status: 404 })
        }
        return new Response('not found', { status: 404 })
      }),
    )

    await expect(
      getAuthorizationServerMetadataDocument(oauth, oauth.authorizationServers[0], 'default'),
    ).resolves.toMatchObject({
      issuer: 'https://issuer.example.com',
      authorization_endpoint: 'https://issuer.example.com/oauth2/authorize',
      token_endpoint: 'https://issuer.example.com/oauth2/token',
      jwks_uri: 'https://issuer.example.com/oauth2/jwks',
      scopes_supported: ['openid', 'profile'],
      resource: 'https://gw.example.com/mcp/default',
    })
  })

  it('falls back from openid configuration to oauth metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const value = String(url)
        if (value === 'https://issuer.example.com/.well-known/openid-configuration') {
          return new Response('{}', { status: 200 })
        }
        if (value === 'https://issuer.example.com/.well-known/oauth-authorization-server') {
          return new Response(
            JSON.stringify({
              issuer: 'https://issuer.example.com',
              authorization_endpoint: 'https://issuer.example.com/auth',
              token_endpoint: 'https://issuer.example.com/token',
              jwks_uri: 'https://issuer.example.com/jwks',
            }),
            { status: 200 },
          )
        }
        return new Response('not found', { status: 404 })
      }),
    )

    await expect(
      getOpenIdConfigurationDocument(oauth, oauth.authorizationServers[0]),
    ).resolves.toMatchObject({
      issuer: 'https://issuer.example.com',
      authorization_endpoint: 'https://issuer.example.com/auth',
      token_endpoint: 'https://issuer.example.com/token',
      jwks_uri: 'https://issuer.example.com/jwks',
      scopes_supported: ['openid', 'profile'],
    })
  })

  it('caches issuer metadata per issuer and document kind', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const value = String(url)
      if (value.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(
          JSON.stringify({
            issuer: 'https://issuer.example.com',
            authorization_endpoint: 'https://issuer.example.com/auth',
            token_endpoint: 'https://issuer.example.com/token',
            jwks_uri: 'https://issuer.example.com/jwks',
          }),
          { status: 200 },
        )
      }
      if (value.endsWith('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            issuer: 'https://issuer.example.com',
            authorization_endpoint: 'https://issuer.example.com/auth',
            token_endpoint: 'https://issuer.example.com/token',
            jwks_uri: 'https://issuer.example.com/jwks',
          }),
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await getAuthorizationServerMetadataDocument(oauth, oauth.authorizationServers[0], 'default')
    await getAuthorizationServerMetadataDocument(oauth, oauth.authorizationServers[0], 'default')
    await getOpenIdConfigurationDocument(oauth, oauth.authorizationServers[0], 'default')
    await getOpenIdConfigurationDocument(oauth, oauth.authorizationServers[0], 'default')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
