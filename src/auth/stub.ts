import type { UserIdentity } from '../types/identity.js'

export function extractIdentity(authHeader: string | undefined): UserIdentity {
  if (!authHeader) {
    return { sub: 'anonymous', roles: ['user'] }
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    return { sub: 'anonymous', roles: ['user'] }
  }

  return { sub: match[1], roles: ['user'] }
}
