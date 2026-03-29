import type { IssuerConfig } from '../config/oauth-schemas.js'
import { discoverJwksUri } from './oauth-discovery.js'
import { resourceAudienceForNamespace, type ResolvedInboundOAuthConfig } from './oauth-config.js'

type JsonRecord = Record<string, unknown>

export type ResolvedIssuerMetadata = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  response_types_supported?: string[]
  grant_types_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
  registration_endpoint?: string
  revocation_endpoint?: string
  introspection_endpoint?: string
  end_session_endpoint?: string
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length > 0 ? items : undefined
}

async function normalizeIssuerMetadata(
  body: JsonRecord,
  issuerCfg: IssuerConfig,
  signal?: AbortSignal,
): Promise<ResolvedIssuerMetadata | null> {
  const issuer = typeof body['issuer'] === 'string' && body['issuer'].length > 0
    ? body['issuer']
    : issuerCfg.issuer.replace(/\/$/, '')
  const authorizationEndpoint = body['authorization_endpoint']
  const tokenEndpoint = body['token_endpoint']
  if (typeof authorizationEndpoint !== 'string' || authorizationEndpoint.length === 0) return null
  if (typeof tokenEndpoint !== 'string' || tokenEndpoint.length === 0) return null
  const jwksUri =
    typeof body['jwks_uri'] === 'string' && body['jwks_uri'].length > 0
      ? body['jwks_uri']
      : issuerCfg.jwksUri ?? await discoverJwksUri(issuerCfg.issuer, signal)

  return {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    jwks_uri: jwksUri,
    response_types_supported: asStringArray(body['response_types_supported']),
    grant_types_supported: asStringArray(body['grant_types_supported']),
    token_endpoint_auth_methods_supported: asStringArray(body['token_endpoint_auth_methods_supported']),
    scopes_supported: asStringArray(body['scopes_supported']),
    code_challenge_methods_supported: asStringArray(body['code_challenge_methods_supported']),
    registration_endpoint:
      typeof body['registration_endpoint'] === 'string' ? body['registration_endpoint'] : undefined,
    revocation_endpoint:
      typeof body['revocation_endpoint'] === 'string' ? body['revocation_endpoint'] : undefined,
    introspection_endpoint:
      typeof body['introspection_endpoint'] === 'string' ? body['introspection_endpoint'] : undefined,
    end_session_endpoint:
      typeof body['end_session_endpoint'] === 'string' ? body['end_session_endpoint'] : undefined,
  }
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<JsonRecord | null> {
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) return null
    const body = await res.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    return body as JsonRecord
  } catch {
    return null
  }
}

async function resolveMetadataFromCandidates(
  issuerCfg: IssuerConfig,
  urls: string[],
  signal?: AbortSignal,
): Promise<ResolvedIssuerMetadata | null> {
  for (const url of urls) {
    const body = await fetchJson(url, signal)
    if (!body) continue
    const normalized = await normalizeIssuerMetadata(body, issuerCfg, signal)
    if (normalized) return normalized
  }
  return null
}

class InboundIssuerMetadataCache {
  private readonly authorizationServerMetadata = new Map<string, Promise<ResolvedIssuerMetadata | null>>()
  private readonly openIdMetadata = new Map<string, Promise<ResolvedIssuerMetadata | null>>()

  async resolveAuthorizationServerMetadata(
    issuerCfg: IssuerConfig,
    signal?: AbortSignal,
  ): Promise<ResolvedIssuerMetadata | null> {
    const key = issuerCfg.issuer.replace(/\/$/, '')
    let cached = this.authorizationServerMetadata.get(key)
    if (!cached) {
      const base = key
      cached = resolveMetadataFromCandidates(
        issuerCfg,
        [
          `${base}/.well-known/oauth-authorization-server`,
          `${base}/.well-known/openid-configuration`,
        ],
        signal,
      )
      this.authorizationServerMetadata.set(key, cached)
    }
    return cached
  }

  async resolveOpenIdMetadata(issuerCfg: IssuerConfig, signal?: AbortSignal): Promise<ResolvedIssuerMetadata | null> {
    const key = issuerCfg.issuer.replace(/\/$/, '')
    let cached = this.openIdMetadata.get(key)
    if (!cached) {
      const base = key
      cached = resolveMetadataFromCandidates(
        issuerCfg,
        [
          `${base}/.well-known/openid-configuration`,
          `${base}/.well-known/oauth-authorization-server`,
        ],
        signal,
      )
      this.openIdMetadata.set(key, cached)
    }
    return cached
  }

  clear(): void {
    this.authorizationServerMetadata.clear()
    this.openIdMetadata.clear()
  }
}

const sharedCache = new InboundIssuerMetadataCache()

function mergeScopes(oauth: ResolvedInboundOAuthConfig, metadata: ResolvedIssuerMetadata): string[] | undefined {
  if (oauth.scopesSupported?.length) return oauth.scopesSupported
  return metadata.scopes_supported?.length ? metadata.scopes_supported : ['openid']
}

export async function getAuthorizationServerMetadataDocument(
  oauth: ResolvedInboundOAuthConfig,
  issuerCfg: IssuerConfig,
  namespace?: string,
  signal?: AbortSignal,
): Promise<JsonRecord | null> {
  const metadata = await sharedCache.resolveAuthorizationServerMetadata(issuerCfg, signal)
  if (!metadata) return null

  return {
    ...metadata,
    ...(mergeScopes(oauth, metadata) ? { scopes_supported: mergeScopes(oauth, metadata) } : {}),
    ...(namespace ? { resource: resourceAudienceForNamespace(oauth, namespace) } : {}),
  }
}

export async function getOpenIdConfigurationDocument(
  oauth: ResolvedInboundOAuthConfig,
  issuerCfg: IssuerConfig,
  namespace?: string,
  signal?: AbortSignal,
): Promise<JsonRecord | null> {
  const metadata = await sharedCache.resolveOpenIdMetadata(issuerCfg, signal)
  if (!metadata) return null

  return {
    ...metadata,
    ...(mergeScopes(oauth, metadata) ? { scopes_supported: mergeScopes(oauth, metadata) } : {}),
    ...(namespace ? { resource: resourceAudienceForNamespace(oauth, namespace) } : {}),
  }
}

export function resetInboundIssuerMetadataCache(): void {
  sharedCache.clear()
}
