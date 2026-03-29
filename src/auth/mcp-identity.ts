import type { AuthConfig } from '../config/schemas.js'
import type { UserIdentity } from '../types/identity.js'
import { getInboundOAuth, getStaticKeysForAuth, oauthAppliesToNamespace } from './oauth-config.js'
import { getOAuthJwtValidator } from './oauth-validator.js'
import { extractBearerToken, resolveStaticKeyFromMap } from './service.js'

export type McpIdentityResult =
  | { kind: 'identity'; identity: UserIdentity }
  | { kind: 'oauth_required' }
  | { kind: 'oauth_invalid' }

/**
 * Resolve caller identity for MCP initialize when OAuth / hybrid may apply.
 */
export async function resolveMcpIdentityForInitialize(
  authHeader: string | undefined,
  auth: AuthConfig,
  namespace: string,
  configuredNamespaceKeys: Set<string>,
  requestOrigin?: string,
): Promise<McpIdentityResult> {
  const token = extractBearerToken(authHeader)
  const staticKeys = getStaticKeysForAuth(auth)

  if (staticKeys && token) {
    const id = resolveStaticKeyFromMap(token, staticKeys)
    if (id) {
      return { kind: 'identity', identity: id }
    }
  }

  const oauth = getInboundOAuth(auth, requestOrigin)
  const oauthActive = oauth && oauthAppliesToNamespace(oauth, namespace, configuredNamespaceKeys)

  if (!oauthActive) {
    if (staticKeys && token) {
      const id = resolveStaticKeyFromMap(token, staticKeys)
      if (id) return { kind: 'identity', identity: id }
    }
    return { kind: 'identity', identity: { sub: 'anonymous', roles: [] } }
  }

  if (!token) {
    return { kind: 'oauth_required' }
  }

  const jwtId = await getOAuthJwtValidator().validate(token, oauth!, namespace)
  if (!jwtId) {
    return { kind: 'oauth_invalid' }
  }
  return { kind: 'identity', identity: jwtId }
}

/**
 * For tools/list and tools/call: ensure Bearer matches session user when OAuth applies.
 */
export async function assertMcpSessionOAuthBearer(
  authHeader: string | undefined,
  auth: AuthConfig,
  namespace: string,
  sessionUserId: string,
  configuredNamespaceKeys: Set<string>,
  requestOrigin?: string,
): Promise<'ok' | 'oauth_required' | 'oauth_invalid' | 'session_mismatch'> {
  const oauth = getInboundOAuth(auth, requestOrigin)
  if (!oauth || !oauthAppliesToNamespace(oauth, namespace, configuredNamespaceKeys)) {
    return 'ok'
  }

  const token = extractBearerToken(authHeader)
  if (!token) {
    return 'oauth_required'
  }

  const staticKeys = getStaticKeysForAuth(auth)
  if (staticKeys) {
    const sid = resolveStaticKeyFromMap(token, staticKeys)
    if (sid) {
      return sid.sub === sessionUserId ? 'ok' : 'session_mismatch'
    }
  }

  const jwtId = await getOAuthJwtValidator().validate(token, oauth, namespace)
  if (!jwtId) {
    return 'oauth_invalid'
  }
  return jwtId.sub === sessionUserId ? 'ok' : 'session_mismatch'
}
