import type { FastifyReply } from 'fastify'

export const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i

export const MCP_ALLOWED_HEADERS = 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version'
export const MCP_EXPOSED_HEADERS = 'Mcp-Session-Id, Mcp-Tools-Changed, MCP-Protocol-Version'

function normalizeConfiguredOrigin(origin: string): string {
  return origin.replace(/\/+$/, '')
}

export function isBrowserOriginAllowed(
  origin: string | undefined,
  allowedBrowserOrigins: string[] | undefined,
): boolean {
  if (!origin) {
    return true
  }
  if (LOOPBACK_ORIGIN.test(origin)) {
    return true
  }
  if (!allowedBrowserOrigins || allowedBrowserOrigins.length === 0) {
    return false
  }
  return allowedBrowserOrigins.some((allowed) => origin === normalizeConfiguredOrigin(allowed))
}

export function setMcpCorsHeaders(
  reply: FastifyReply,
  origin: string | undefined,
  allowedBrowserOrigins: string[] | undefined,
): void {
  if (!origin || !isBrowserOriginAllowed(origin, allowedBrowserOrigins)) {
    return
  }

  reply.header('Access-Control-Allow-Origin', origin)
  reply.header('Vary', 'Origin')
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE')
  reply.header('Access-Control-Allow-Headers', MCP_ALLOWED_HEADERS)
  reply.header('Access-Control-Expose-Headers', MCP_EXPOSED_HEADERS)
}
