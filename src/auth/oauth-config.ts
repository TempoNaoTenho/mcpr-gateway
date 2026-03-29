import type { AuthConfig } from '../config/schemas.js'
import type { InboundOAuthConfig } from '../config/oauth-schemas.js'

export function getInboundOAuth(auth: AuthConfig): InboundOAuthConfig | undefined {
  if (auth.mode === 'oauth' || auth.mode === 'hybrid') {
    return auth.oauth
  }
  return undefined
}

export function getStaticKeysForAuth(
  auth: AuthConfig,
): Record<string, { userId: string; roles: string[] }> | undefined {
  if (auth.mode === 'static_key') return auth.staticKeys
  if (auth.mode === 'hybrid') return auth.staticKeys
  return undefined
}

/** When empty/absent, OAuth rules apply to all configured namespace keys. */
export function oauthAppliesToNamespace(
  oauth: InboundOAuthConfig,
  namespace: string,
  configuredNamespaceKeys: Set<string>,
): boolean {
  if (!configuredNamespaceKeys.has(namespace)) {
    return false
  }
  const req = oauth.requireForNamespaces
  if (req !== undefined && req.length > 0) {
    return req.includes(namespace)
  }
  return true
}

export function resourceAudienceForNamespace(oauth: InboundOAuthConfig, namespace: string): string {
  const base = oauth.publicBaseUrl.replace(/\/$/, '')
  return `${base}/mcp/${namespace}`
}
