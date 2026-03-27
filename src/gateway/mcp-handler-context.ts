import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify'

export type McpHandlerContext = {
  namespace: string
  /** Present for tools/list and tools/call; omitted for initialize */
  sessionId?: string
  authorization?: string
  requestId: string
  log?: FastifyBaseLogger
  /** Streamable HTTP: MCP-Protocol-Version request header when present */
  mcpProtocolVersionHeader?: string
  /** HTTP transport: maps to Mcp-Tools-Changed when the session opts into listChanged */
  setToolsListChangedHeader?: (toolsChanged: boolean) => void
}

export function mcpContextFromFastifyRequest(
  request: FastifyRequest,
  options: {
    sessionId?: string
    reply?: FastifyReply
  } = {},
): McpHandlerContext {
  const rawHeader = request.headers['mcp-session-id']
  const headerSession = typeof rawHeader === 'string' ? rawHeader : undefined
  const setToolsListChangedHeader = options.reply
    ? (toolsChanged: boolean) => {
        options.reply!.header('Mcp-Tools-Changed', toolsChanged ? 'true' : 'false')
      }
    : undefined

  const protoHdr = request.headers['mcp-protocol-version']
  const mcpProtocolVersionHeader = typeof protoHdr === 'string' ? protoHdr : undefined

  return {
    namespace: (request.params as { namespace: string }).namespace,
    sessionId: options.sessionId ?? headerSession,
    authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
    requestId: String(request.id),
    log: request.log,
    mcpProtocolVersionHeader,
    setToolsListChangedHeader,
  }
}
