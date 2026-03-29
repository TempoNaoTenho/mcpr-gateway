import type { AuthConfig } from '../config/schemas.js'
import {
  DEFAULT_EMBEDDED_BROWSER_ORIGINS,
  type InboundOAuthConfig,
  type IssuerConfig,
} from '../config/oauth-schemas.js'

export type ResolvedInboundOAuthConfig = Omit<InboundOAuthConfig, 'provider' | 'publicBaseUrl' | 'authorizationServers'> & {
  provider: 'embedded' | 'external'
  publicBaseUrl: string
  authorizationServers: IssuerConfig[]
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function defaultBrowserOrigins(origins: string[] | undefined): string[] {
  return [...new Set([...(origins ?? []), ...DEFAULT_EMBEDDED_BROWSER_ORIGINS])]
}

function providerFromPolicy(
  oauth: Extract<AuthConfig, { mode: 'oauth' | 'hybrid' }>['oauth'],
): 'embedded' | 'external' {
  if (oauth.provider === 'embedded' || oauth.provider === 'external') {
    return oauth.provider
  }
  return oauth.authorizationServers.length > 0 ? 'external' : 'embedded'
}

function normalizeExternalIssuers(
  oauth: Extract<AuthConfig, { mode: 'oauth' | 'hybrid' }>['oauth'],
): IssuerConfig[] {
  return oauth.authorizationServers
    .filter((server): server is IssuerConfig => typeof server.issuer === 'string' && server.issuer.length > 0)
    .map((server) => ({
      issuer: server.issuer,
      audience: server.audience,
      jwksUri: server.jwksUri,
      rolesClaim: server.rolesClaim ?? 'roles',
    }))
}

function normalizedPublicBaseUrl(
  oauth: Extract<AuthConfig, { mode: 'oauth' | 'hybrid' }>['oauth'],
  requestOrigin?: string,
): string | undefined {
  return oauth.publicBaseUrl ? trimTrailingSlash(oauth.publicBaseUrl) : requestOrigin ? trimTrailingSlash(requestOrigin) : undefined
}

export function getInboundOAuth(
  auth: AuthConfig,
  requestOrigin?: string,
): ResolvedInboundOAuthConfig | undefined {
  if (auth.mode !== 'oauth' && auth.mode !== 'hybrid') {
    return undefined
  }

  const provider = providerFromPolicy(auth.oauth)
  const publicBaseUrl = normalizedPublicBaseUrl(auth.oauth, requestOrigin)
  if (!publicBaseUrl) {
    return undefined
  }

  if (provider === 'embedded') {
    return {
      ...auth.oauth,
      provider,
      publicBaseUrl,
      authorizationServers: [
        {
          issuer: publicBaseUrl,
          jwksUri: `${publicBaseUrl}/.well-known/jwks.json`,
          rolesClaim: 'roles',
        },
      ],
      allowedBrowserOrigins: defaultBrowserOrigins(auth.oauth.allowedBrowserOrigins),
    }
  }

  const authorizationServers = normalizeExternalIssuers(auth.oauth)
  if (authorizationServers.length === 0) {
    return undefined
  }

  return {
    ...auth.oauth,
    provider,
    publicBaseUrl,
    authorizationServers,
    allowedBrowserOrigins: auth.oauth.allowedBrowserOrigins,
  }
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
  oauth: ResolvedInboundOAuthConfig,
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

export function resourceAudienceForNamespace(oauth: ResolvedInboundOAuthConfig, namespace: string): string {
  return `${trimTrailingSlash(oauth.publicBaseUrl)}/mcp/${namespace}`
}
