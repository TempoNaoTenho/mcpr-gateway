import type { FastifyRequest, FastifyReply } from 'fastify'
import { getConfig } from '../../config/index.js'
import { SessionStatus } from '../../types/enums.js'
import { GatewayError, GatewayErrorCode } from '../../types/errors.js'
import { SessionIdSchema } from '../../types/identity.js'
import type { ISessionStore } from '../../types/interfaces.js'
import { projectWindow } from '../publish/project.js'
import { logRequest } from '../../observability/structured-log.js'

interface JsonRpcBody {
  jsonrpc: string
  id: number | string | null
  method: string
  params?: Record<string, unknown>
}

export async function handleToolsList(
  request: FastifyRequest,
  body: JsonRpcBody,
  store: ISessionStore,
  reply?: FastifyReply,
): Promise<unknown> {
  const namespace = (request.params as { namespace: string }).namespace
  const rawSessionId = request.headers['mcp-session-id']
  if (!rawSessionId || typeof rawSessionId !== 'string') {
    throw new GatewayError(GatewayErrorCode.SESSION_NOT_FOUND)
  }

  const sessionId = SessionIdSchema.parse(rawSessionId)
  const session = await store.get(sessionId)

  if (!session || session.status !== SessionStatus.Active) {
    throw new GatewayError(GatewayErrorCode.SESSION_NOT_FOUND)
  }
  if (session.namespace !== namespace) {
    throw new GatewayError(GatewayErrorCode.SESSION_NOT_FOUND)
  }

  const startMs = Date.now()
  const pendingToolListChange = session.pendingToolListChange === true
  await store.set(sessionId, {
    ...session,
    lastActiveAt: new Date().toISOString(),
    pendingToolListChange: false,
  })

  if (reply && session.clientCapabilities?.supportsToolListChanged) {
    reply.header('Mcp-Tools-Changed', pendingToolListChange ? 'true' : 'false')
  }

  const tools = session.toolWindow.length > 0
    ? projectWindow(session.toolWindow, getConfig().selector)
    : []

  logRequest(request.log, {
    requestId: request.id,
    sessionId,
    namespace,
    method: 'tools/list',
    userId: session.userId,
    latencyMs: Date.now() - startMs,
  }, 'tools listed')

  return {
    jsonrpc: '2.0',
    id: body.id,
    result: { tools },
  }
}
