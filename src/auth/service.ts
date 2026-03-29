import type { UserIdentity } from '../types/identity.js'
import type { AuthConfig } from '../config/schemas.js'
import { getStaticKeysForAuth } from './oauth-config.js'

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match ? (match[1] ?? null) : null
}

export function resolveStaticKeyFromMap(
  token: string | null,
  staticKeys: Record<string, { userId: string; roles: string[] }>,
): UserIdentity | null {
  if (!token) {
    return null
  }

  const entry = staticKeys[token]
  if (!entry) {
    return null
  }

  return { sub: entry.userId, roles: entry.roles }
}

export function resolveIdentity(
  authHeader: string | undefined,
  authConfig: AuthConfig
): UserIdentity {
  const token = extractBearerToken(authHeader)
  const staticKeys = getStaticKeysForAuth(authConfig)
  const persistedIdentity = staticKeys ? resolveStaticKeyFromMap(token, staticKeys) : null

  if (persistedIdentity) {
    return persistedIdentity
  }

  return { sub: 'anonymous', roles: [] }
}
