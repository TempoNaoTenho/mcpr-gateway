import { SessionStatus, OutcomeClass, AuditEventType } from '../../types/enums.js'
import { GatewayError, GatewayErrorCode } from '../../types/errors.js'
import { SessionIdSchema } from '../../types/identity.js'
import type { IExecutionRouter, ISessionStore, IAuditLogger } from '../../types/interfaces.js'
import type { TriggerEngine } from '../../trigger/index.js'
import { logRequest, logRequestWarn } from '../../observability/structured-log.js'
import {
  isGatewayInternalTool,
  GATEWAY_SEARCH_TOOL_NAME,
  GATEWAY_CALL_TOOL_NAME,
  GATEWAY_HELP_TOOL_NAME,
  GATEWAY_RUN_CODE_TOOL_NAME,
} from '../discovery.js'
import type { McpHandlerContext } from '../mcp-handler-context.js'
import type { JsonRpcBody } from '../jsonrpc.js'
import { assertMcpProtocolVersionMatches } from '../mcp-protocol-version.js'
import { getConfig } from '../../config/index.js'
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

type CallToolTextContent = {
  type: 'text'
  text: string
}

type CallToolResult = {
  content: CallToolTextContent[]
  structuredContent?: unknown
}

function isToolArguments(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTextContentBlock(value: unknown): value is CallToolTextContent {
  return (
    isRecord(value) &&
    value['type'] === 'text' &&
    typeof value['text'] === 'string'
  )
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    isRecord(value) &&
    Array.isArray(value['content']) &&
    value['content'].every(isTextContentBlock)
  )
}

function stringifyForToolText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function normalizeInternalToolResult(toolName: string, value: unknown): CallToolResult {
  if (isCallToolResult(value)) return value

  if (toolName === GATEWAY_HELP_TOOL_NAME && isRecord(value) && typeof value['text'] === 'string') {
    return {
      content: [{ type: 'text', text: value['text'] }],
      structuredContent: value,
    }
  }

  if (
    toolName === GATEWAY_SEARCH_TOOL_NAME &&
    isRecord(value) &&
    Array.isArray(value['matches'])
  ) {
    const query = typeof value['query'] === 'string' ? value['query'] : ''
    const matches = value['matches']
      .filter(isRecord)
      .map((match) => {
        const name = typeof match['name'] === 'string' ? match['name'] : '<unknown>'
        const serverId = typeof match['serverId'] === 'string' ? match['serverId'] : '<unknown>'
        const description =
          typeof match['description'] === 'string' ? match['description'].trim() : ''
        return description.length > 0
          ? `- ${name} (${serverId}): ${description}`
          : `- ${name} (${serverId})`
      })

    const text =
      matches.length > 0
        ? [`Matches for "${query}":`, ...matches].join('\n')
        : `No matching tools found for "${query}".`

    return {
      content: [{ type: 'text', text }],
      structuredContent: value,
    }
  }

  if (toolName === GATEWAY_RUN_CODE_TOOL_NAME && isRecord(value) && 'value' in value) {
    return {
      content: [{ type: 'text', text: stringifyForToolText(value['value']) }],
      structuredContent: value,
    }
  }

  return {
    content: [{ type: 'text', text: stringifyForToolText(value) }],
    structuredContent: value,
  }
}

export async function handleToolsCall(
  ctx: McpHandlerContext,
  body: JsonRpcBody,
  store: ISessionStore,
  router: IExecutionRouter,
  triggerEngine: TriggerEngine,
  auditLogger?: IAuditLogger
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

  await store.set(sessionId, { ...session, lastActiveAt: new Date().toISOString() })

  const toolName = body.params?.['name']
  if (!toolName || typeof toolName !== 'string') {
    throw new GatewayError(GatewayErrorCode.INVALID_TOOL_ARGUMENTS, 'Missing tool name in params')
  }

  logRequest(
    ctx.log,
    {
      requestId: ctx.requestId,
      sessionId,
      namespace,
      method: 'tools/call',
      userId: session.userId,
      toolName,
      latencyMs: 0,
    },
    'tool call started',
  )

  const rawArgs = body.params?.['arguments']
  const args = rawArgs ?? {}
  if (!isToolArguments(args)) {
    logRequestWarn(
      ctx.log,
      {
        requestId: ctx.requestId,
        sessionId,
        namespace,
        method: 'tools/call',
        userId: session.userId,
        toolName,
        latencyMs: 0,
        outcomeClass: OutcomeClass.ToolError,
        errorMessage: 'Tool arguments must be an object',
      },
      'tool call rejected: invalid arguments shape',
    )
    throw new GatewayError(
      GatewayErrorCode.INVALID_TOOL_ARGUMENTS,
      'Tool arguments must be an object'
    )
  }

  const callStart = Date.now()
  const outcome = await router.route(toolName, args, sessionId)
  if (!isGatewayInternalTool(outcome.toolName, outcome.serverId)) {
    await triggerEngine.evaluate(sessionId, outcome)
  }

  const latencyMs = Date.now() - callStart
  const now = new Date().toISOString()

  switch (outcome.outcome) {
    case OutcomeClass.Success: {
      auditLogger?.emit({
        type: AuditEventType.ToolExecuted,
        sessionId,
        userId: session.userId,
        toolName,
        downstreamServer: outcome.serverId,
        outcome: OutcomeClass.Success,
        latencyMs,
        timestamp: now,
      })
      logRequest(
        ctx.log,
        {
          requestId: ctx.requestId,
          sessionId,
          namespace,
          method: 'tools/call',
          userId: session.userId,
          toolName,
          downstreamServer: outcome.serverId,
          latencyMs,
          outcomeClass: OutcomeClass.Success,
        },
        'tool executed'
      )
      const result = isGatewayInternalTool(outcome.toolName, outcome.serverId)
        ? normalizeInternalToolResult(toolName, outcome.result)
        : outcome.result
      return {
        jsonrpc: '2.0',
        id: body.id,
        result,
      }
    }

    case OutcomeClass.ToolError:
      if (outcome.error === 'TOOL_NOT_VISIBLE') {
        auditLogger?.emit({
          type: AuditEventType.ExecutionDenied,
          sessionId,
          userId: session.userId,
          toolName,
          reason: 'tool not visible in current session window',
          timestamp: now,
        })
        logRequestWarn(
          ctx.log,
          {
            requestId: ctx.requestId,
            sessionId,
            namespace,
            method: 'tools/call',
            userId: session.userId,
            toolName,
            downstreamServer: outcome.serverId || undefined,
            latencyMs,
            outcomeClass: OutcomeClass.ToolError,
            errorMessage: outcome.error ?? 'TOOL_NOT_VISIBLE',
          },
          'tool execution denied: not visible',
        )

        const toolWindowNames = new Set(session.toolWindow.map((t) => t.name))
        const isCompatMode =
          toolWindowNames.has(GATEWAY_SEARCH_TOOL_NAME) &&
          toolWindowNames.has(GATEWAY_CALL_TOOL_NAME)

        if (isCompatMode) {
          throw new GatewayError(
            GatewayErrorCode.TOOL_NOT_VISIBLE,
            `Tool '${toolName}' is not in the current session tool window. ` +
              'In compat mode, first call gateway_search_tools with a query to discover available tools, ' +
              `then call gateway_call_tool with the exact tool name and serverId returned by the search result. ` +
              'Do not call downstream tools directly.'
          )
        }
        throw new GatewayError(GatewayErrorCode.TOOL_NOT_VISIBLE)
      }
      if (outcome.error === 'AMBIGUOUS_TOOL_NAME') {
        logRequestWarn(
          ctx.log,
          {
            requestId: ctx.requestId,
            sessionId,
            namespace,
            method: 'tools/call',
            userId: session.userId,
            toolName,
            latencyMs,
            outcomeClass: OutcomeClass.ToolError,
            errorMessage: 'AMBIGUOUS_TOOL_NAME',
          },
          'tool call failed: ambiguous tool name',
        )
        throw new GatewayError(
          GatewayErrorCode.INVALID_TOOL_ARGUMENTS,
          'Tool name is ambiguous within the current session'
        )
      }
      auditLogger?.emit({
        type: AuditEventType.ToolExecuted,
        sessionId,
        userId: session.userId,
        toolName,
        downstreamServer: outcome.serverId,
        outcome: OutcomeClass.ToolError,
        latencyMs,
        timestamp: now,
      })
      const downstreamRpcMessage = outcome.error ?? 'Tool execution error'
      logRequestWarn(
        ctx.log,
        {
          requestId: ctx.requestId,
          sessionId,
          namespace,
          method: 'tools/call',
          userId: session.userId,
          toolName,
          downstreamServer: outcome.serverId || undefined,
          latencyMs,
          outcomeClass: OutcomeClass.ToolError,
          errorMessage: downstreamRpcMessage,
        },
        'tool error: downstream reported failure',
      )
      return {
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32000, message: downstreamRpcMessage },
      }

    case OutcomeClass.UnavailableDownstream: {
      const msg = outcome.error ?? GatewayErrorCode.DOWNSTREAM_UNAVAILABLE
      logRequestWarn(
        ctx.log,
        {
          requestId: ctx.requestId,
          sessionId,
          namespace,
          method: 'tools/call',
          userId: session.userId,
          toolName,
          downstreamServer: outcome.serverId || undefined,
          latencyMs,
          outcomeClass: OutcomeClass.UnavailableDownstream,
          errorMessage: msg,
        },
        'tool call failed: downstream unavailable',
      )
      throw new GatewayError(GatewayErrorCode.DOWNSTREAM_UNAVAILABLE)
    }

    case OutcomeClass.Timeout: {
      const msg = outcome.error ?? GatewayErrorCode.DOWNSTREAM_TIMEOUT
      logRequestWarn(
        ctx.log,
        {
          requestId: ctx.requestId,
          sessionId,
          namespace,
          method: 'tools/call',
          userId: session.userId,
          toolName,
          downstreamServer: outcome.serverId || undefined,
          latencyMs,
          outcomeClass: OutcomeClass.Timeout,
          errorMessage: msg,
        },
        'tool call failed: downstream timeout',
      )
      throw new GatewayError(GatewayErrorCode.DOWNSTREAM_TIMEOUT)
    }

    case OutcomeClass.TransportError: {
      const msg = outcome.error ?? 'transport error'
      logRequestWarn(
        ctx.log,
        {
          requestId: ctx.requestId,
          sessionId,
          namespace,
          method: 'tools/call',
          userId: session.userId,
          toolName,
          downstreamServer: outcome.serverId || undefined,
          latencyMs,
          outcomeClass: OutcomeClass.TransportError,
          errorMessage: msg,
        },
        'tool call failed: transport error',
      )
      throw new GatewayError(GatewayErrorCode.DOWNSTREAM_UNAVAILABLE, outcome.error)
    }

    case OutcomeClass.AuthError: {
      logRequestWarn(
        ctx.log,
        {
          requestId: ctx.requestId,
          sessionId,
          namespace,
          method: 'tools/call',
          userId: session.userId,
          toolName,
          downstreamServer: outcome.serverId || undefined,
          latencyMs,
          outcomeClass: OutcomeClass.AuthError,
          errorMessage: outcome.error ?? 'auth error',
        },
        'tool call failed: auth error',
      )
      throw new GatewayError(GatewayErrorCode.SESSION_NOT_FOUND)
    }

    default:
      logRequestWarn(
        ctx.log,
        {
          requestId: ctx.requestId,
          sessionId,
          namespace,
          method: 'tools/call',
          userId: session.userId,
          toolName,
          downstreamServer: outcome.serverId || undefined,
          latencyMs,
          outcomeClass: outcome.outcome,
          errorMessage: 'unexpected outcome from router',
        },
        'tool call failed: internal routing outcome',
      )
      throw new GatewayError(GatewayErrorCode.INTERNAL_GATEWAY_ERROR)
  }
}
