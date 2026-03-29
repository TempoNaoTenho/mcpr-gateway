import { describe, expect, it } from 'vitest'
import {
  getInboundOAuth,
  getStaticKeysForAuth,
  oauthAppliesToNamespace,
  resourceAudienceForNamespace,
} from '../../src/auth/oauth-config.js'
import type { AuthConfig } from '../../src/config/schemas.js'

describe('oauth-config helpers', () => {
  const nsKeys = new Set(['a', 'b'])

  it('getInboundOAuth returns config only when oauth is fully configured', () => {
    const staticOnly: AuthConfig = { mode: 'static_key' }
    expect(getInboundOAuth(staticOnly)).toBeUndefined()
    const hybridDraft: AuthConfig = {
      mode: 'hybrid',
      oauth: {
        authorizationServers: [],
      },
    }
    expect(getInboundOAuth(hybridDraft)).toBeUndefined()
    const oauth: AuthConfig = {
      mode: 'oauth',
      oauth: {
        publicBaseUrl: 'https://x.example',
        authorizationServers: [{ issuer: 'https://idp' }],
      },
    }
    expect(getInboundOAuth(oauth)?.publicBaseUrl).toBe('https://x.example')
  })

  it('getStaticKeysForAuth is defined for static_key and hybrid only', () => {
    expect(getStaticKeysForAuth({ mode: 'static_key', staticKeys: { t: { userId: 'u', roles: [] } } })).toEqual({
      t: { userId: 'u', roles: [] },
    })
    expect(
      getStaticKeysForAuth({
        mode: 'oauth',
        oauth: { publicBaseUrl: 'https://x', authorizationServers: [{ issuer: 'https://idp' }] },
      }),
    ).toBeUndefined()
  })

  it('oauthAppliesToNamespace respects requireForNamespaces', () => {
    const oauth = {
      publicBaseUrl: 'https://x',
      authorizationServers: [{ issuer: 'https://idp' }],
      requireForNamespaces: ['a'],
    }
    expect(oauthAppliesToNamespace(oauth, 'a', nsKeys)).toBe(true)
    expect(oauthAppliesToNamespace(oauth, 'b', nsKeys)).toBe(false)
    expect(oauthAppliesToNamespace(oauth, 'missing', nsKeys)).toBe(false)
  })

  it('resourceAudienceForNamespace strips trailing slash on base URL', () => {
    expect(
      resourceAudienceForNamespace(
        { publicBaseUrl: 'https://gw/', authorizationServers: [{ issuer: 'https://i' }] },
        'ns',
      ),
    ).toBe('https://gw/mcp/ns')
  })
})
