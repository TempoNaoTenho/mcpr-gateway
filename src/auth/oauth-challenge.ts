import { resourceAudienceForNamespace, type ResolvedInboundOAuthConfig } from './oauth-config.js'

export type OAuthChallengeDetails = {
  wwwAuthenticate: string
}

/**
 * Build WWW-Authenticate for MCP Authorization (resource metadata URL + scope).
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
 */
export function buildOAuthChallenge(
  oauth: ResolvedInboundOAuthConfig,
  namespace: string,
  error?: 'invalid_token',
): OAuthChallengeDetails {
  const base = oauth.publicBaseUrl.replace(/\/$/, '')
  const resourceMeta = `${base}/.well-known/oauth-protected-resource/mcp/${namespace}`
  const scopes = oauth.scopesSupported?.length
    ? oauth.scopesSupported.join(' ')
    : 'openid'
  let directive = `Bearer resource_metadata="${resourceMeta}", scope="${scopes}"`
  if (error) {
    directive += `, error="${error}"`
  }
  return { wwwAuthenticate: directive }
}

export function expectedResourceParameter(oauth: ResolvedInboundOAuthConfig, namespace: string): string {
  return resourceAudienceForNamespace(oauth, namespace)
}
