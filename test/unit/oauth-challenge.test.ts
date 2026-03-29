import { describe, expect, it } from 'vitest'
import { buildOAuthChallenge, expectedResourceParameter } from '../../src/auth/oauth-challenge.js'
import type { InboundOAuthConfig } from '../../src/config/oauth-schemas.js'

const oauth: InboundOAuthConfig = {
  publicBaseUrl: 'https://gw.example.com/',
  authorizationServers: [{ issuer: 'https://idp.example/' }],
  scopesSupported: ['mcp.read', 'mcp.write'],
}

describe('buildOAuthChallenge', () => {
  it('includes resource_metadata URL and space-delimited scopes', () => {
    const { wwwAuthenticate } = buildOAuthChallenge(oauth, 'mail')
    expect(wwwAuthenticate).toContain(
      'resource_metadata="https://gw.example.com/.well-known/oauth-protected-resource/mcp/mail"',
    )
    expect(wwwAuthenticate).toContain('scope="mcp.read mcp.write"')
    expect(wwwAuthenticate.startsWith('Bearer ')).toBe(true)
  })

  it('defaults scope to openid when scopes_supported absent', () => {
    const { wwwAuthenticate } = buildOAuthChallenge(
      { ...oauth, scopesSupported: undefined },
      'mail',
    )
    expect(wwwAuthenticate).toContain('scope="openid"')
  })

  it('adds invalid_token when requested', () => {
    const { wwwAuthenticate } = buildOAuthChallenge(oauth, 'mail', 'invalid_token')
    expect(wwwAuthenticate).toContain('error="invalid_token"')
  })
})

describe('expectedResourceParameter', () => {
  it('matches resource audience for namespace', () => {
    expect(expectedResourceParameter(oauth, 'dev')).toBe('https://gw.example.com/mcp/dev')
  })
})
