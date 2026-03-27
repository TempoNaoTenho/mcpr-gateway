import { GatewayError, GatewayErrorCode } from '../types/errors.js'
import type { SessionState } from '../types/session.js'

/** Versions this gateway implements, newest first. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

const supportedSet = new Set<string>(SUPPORTED_MCP_PROTOCOL_VERSIONS)

/**
 * MCP lifecycle: if the client requests a version we support, echo it; if the request is
 * missing (legacy clients), default to 2024-11-05; otherwise offer our newest supported.
 */
export function negotiateMcpProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && supportedSet.has(requested)) {
    return requested
  }
  if (requested === undefined) {
    return '2024-11-05'
  }
  return SUPPORTED_MCP_PROTOCOL_VERSIONS[0]
}

export function assertMcpProtocolVersionMatches(
  session: SessionState,
  headerValue: string | undefined,
): void {
  if (headerValue === undefined) {
    return
  }
  const expected = session.mcpProtocolVersion ?? '2024-11-05'
  if (headerValue !== expected) {
    throw new GatewayError(
      GatewayErrorCode.INVALID_MCP_PROTOCOL_VERSION,
      `MCP-Protocol-Version header does not match negotiated protocol version (expected ${expected}, received ${headerValue})`,
      { expected, received: headerValue },
    )
  }
}
