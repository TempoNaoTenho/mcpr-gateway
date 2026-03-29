import { timingSafeEqual } from 'node:crypto'
import { nanoid } from 'nanoid'
import { getGatewayAdminUserFromEnv } from '../security/runtime-config.js'

const adminSessions = new Map<string, { createdAt: number }>()
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000

function pruneAdminSessions() {
  const now = Date.now()
  for (const [id, s] of adminSessions) {
    if (now - s.createdAt > SESSION_TTL_MS) adminSessions.delete(id)
  }
}

export function isValidAdminSession(sessionId: string): boolean {
  pruneAdminSessions()
  const s = adminSessions.get(sessionId)
  if (!s) return false
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    adminSessions.delete(sessionId)
    return false
  }
  return true
}

export function createAdminSession(): string {
  const sessionId = nanoid(32)
  adminSessions.set(sessionId, { createdAt: Date.now() })
  return sessionId
}

export function revokeAdminSession(sessionId: string | undefined): void {
  if (!sessionId) return
  adminSessions.delete(sessionId)
}

function timingSafeStrEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8')
  const bufB = Buffer.from(b, 'utf-8')
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

export function getGatewayAdminUser(): string {
  return getGatewayAdminUserFromEnv(process.env)
}

export function getGatewayAdminPassword(): string | undefined {
  const value = process.env['GATEWAY_ADMIN_PASSWORD']
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function validateAdminCredentials(username: string | undefined, password: string | undefined): boolean {
  const expectedUser = getGatewayAdminUser()
  const adminPasswordEnv = getGatewayAdminPassword()
  if (!adminPasswordEnv) return false
  return timingSafeStrEqual((username ?? '').trim(), expectedUser) && timingSafeStrEqual((password ?? '').trim(), adminPasswordEnv)
}

export function authCookieHeaders(sessionId: string, isProduction: boolean): string[] {
  const suffix = `${isProduction ? '; Secure' : ''}; Max-Age=${SESSION_TTL_MS / 1000}`
  return [
    `admin_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict${suffix}`,
    `oauth_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax${suffix}`,
  ]
}

export function clearAuthCookieHeaders(isProduction: boolean): string[] {
  const suffix = `${isProduction ? '; Secure' : ''}; Max-Age=0`
  return [
    `admin_session=; Path=/; HttpOnly; SameSite=Strict${suffix}`,
    `oauth_session=; Path=/; HttpOnly; SameSite=Lax${suffix}`,
  ]
}

export function sessionFromCookies(cookies: Record<string, string> | undefined): string | undefined {
  const strictSession = cookies?.['admin_session']
  if (strictSession && isValidAdminSession(strictSession)) return strictSession
  const laxSession = cookies?.['oauth_session']
  if (laxSession && isValidAdminSession(laxSession)) return laxSession
  return undefined
}
