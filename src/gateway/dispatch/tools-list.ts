import { getConfig } from '../../config/index.js'
import { SessionStatus } from '../../types/enums.js'
import { GatewayError, GatewayErrorCode } from '../../types/errors.js'
import { SessionIdSchema } from '../../types/identity.js'
import type { ISessionStore } from '../../types/interfaces.js'
import { projectWindow } from '../publish/project.js'
import { logRequest } from '../../observability/structured-log.js'
import type { McpHandlerContext } from '../mcp-handler-context.js'
import type { JsonRpcBody } from '../jsonrpc.js'
import { assertMcpProtocolVersionMatches } from '../mcp-protocol-version.js'
import { assertMcpSessionOAuthBearer } from '../../auth/mcp-identity.js'
import { getInboundOAuth } from '../../auth/oauth-config.js'
import { buildOAuthChallenge } from '../../auth/oauth-challenge.js'

function oauthChallengeError(
  code: 'OAUTH_AUTHENTICATION_REQUIRED' | 'OAUTH_INVALID_TOKEN',
  namespace: string,
  requestOrigin?: string,
): GatewayError {
  const oauth = getInboundOAuth(getConfig().auth, requestOrigin)
  if (!oauth) {
    return new GatewayError(GatewayErrorCode.INTERNAL_GATEWAY_ERROR)
  }
  const challenge =
    code === GatewayErrorCode.OAUTH_INVALID_TOKEN
      ? buildOAuthChallenge(oauth, namespace, 'invalid_token')
      : buildOAuthChallenge(oauth, namespace)
  return new GatewayError(code, undefined, undefined, {
    'WWW-Authenticate': challenge.wwwAuthenticate,
  })
}

export async function handleToolsList(
  ctx: McpHandlerContext,
  body: JsonRpcBody,
  store: ISessionStore,
): Promise<unknown> {
  const namespace = ctx.namespace
  const rawSessionId = ctx.sessionId
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

  const nsKeys = new Set(Object.keys(getConfig().namespaces))
  const check = await assertMcpSessionOAuthBearer(
    ctx.authorization,
    getConfig().auth,
    namespace,
    session.userId,
    nsKeys,
    ctx.requestOrigin,
  )
  if (check === 'oauth_required') {
    throw oauthChallengeError(GatewayErrorCode.OAUTH_AUTHENTICATION_REQUIRED, namespace, ctx.requestOrigin)
  }
  if (check === 'oauth_invalid' || check === 'session_mismatch') {
    throw oauthChallengeError(GatewayErrorCode.OAUTH_INVALID_TOKEN, namespace, ctx.requestOrigin)
  }

  assertMcpProtocolVersionMatches(session, ctx.mcpProtocolVersionHeader)

  const startMs = Date.now()
  const pendingToolListChange = session.pendingToolListChange === true
  await store.set(sessionId, {
    ...session,
    lastActiveAt: new Date().toISOString(),
    pendingToolListChange: false,
  })

  if (session.clientCapabilities?.supportsToolListChanged) {
    ctx.setToolsListChangedHeader?.(pendingToolListChange)
  }

  const tools =
    session.toolWindow.length > 0 ? projectWindow(session.toolWindow, getConfig().selector) : []

  logRequest(
    ctx.log,
    {
      requestId: ctx.requestId,
      sessionId,
      namespace,
      method: 'tools/list',
      userId: session.userId,
      latencyMs: Date.now() - startMs,
    },
    'tools listed',
  )

  return {
    jsonrpc: '2.0',
    id: body.id,
    result: { tools },
  }
}
