import type { UserIdentity } from '../types/identity.js'
import type { AuthConfig } from '../config/schemas.js'

export function resolveIdentity(
  authHeader: string | undefined,
  authConfig: AuthConfig,
): UserIdentity {
  const token = extractBearer(authHeader)
  const persistedIdentity = resolveStaticKey(token, authConfig)

  if (persistedIdentity) {
    return persistedIdentity
  }

  if (authConfig.mode === 'mock_dev') {
    return resolveMockDev(token)
  }

  return { sub: 'anonymous', roles: [] }
}

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match ? (match[1] ?? null) : null
}

function resolveMockDev(token: string | null): UserIdentity {
  if (!token) {
    return { sub: 'anonymous', roles: [] }
  }

  const colonIdx = token.indexOf(':')
  if (colonIdx === -1) {
    return { sub: token, roles: [] }
  }

  const userId = token.slice(0, colonIdx)
  const rolesPart = token.slice(colonIdx + 1)
  const roles = rolesPart
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)

  return { sub: userId, roles }
}

function resolveStaticKey(
  token: string | null,
  authConfig: AuthConfig,
) : UserIdentity | null {
  if (!token) {
    return null
  }

  const entry = authConfig.staticKeys?.[token]
  if (!entry) {
    return null
  }

  return { sub: entry.userId, roles: entry.roles }
}
