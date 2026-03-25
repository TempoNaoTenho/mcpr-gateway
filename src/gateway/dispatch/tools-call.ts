import { SessionStatus, OutcomeClass, AuditEventType } from '../../types/enums.js'
import { GatewayError, GatewayErrorCode } from '../../types/errors.js'
import { SessionIdSchema } from '../../types/identity.js'
import type { IExecutionRouter, ISessionStore, IAuditLogger } from '../../types/interfaces.js'
import type { TriggerEngine } from '../../trigger/index.js'
import { logRequest } from '../../observability/structured-log.js'
import {
  isGatewayInternalTool,
  GATEWAY_SEARCH_TOOL_NAME,
  GATEWAY_CALL_TOOL_NAME,
} from '../discovery.js'
import type { McpHandlerContext } from '../mcp-handler-context.js'
import type { JsonRpcBody } from '../jsonrpc.js'

function isToolArguments(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

  await store.set(sessionId, { ...session, lastActiveAt: new Date().toISOString() })

  const toolName = body.params?.['name']
  if (!toolName || typeof toolName !== 'string') {
    throw new GatewayError(GatewayErrorCode.INVALID_TOOL_ARGUMENTS, 'Missing tool name in params')
  }

  const rawArgs = body.params?.['arguments']
  const args = rawArgs ?? {}
  if (!isToolArguments(args)) {
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
          downstreamServer: outcome.serverId,
          latencyMs,
          outcomeClass: OutcomeClass.Success,
        },
        'tool executed'
      )
      return {
        jsonrpc: '2.0',
        id: body.id,
        result: outcome.result,
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
        logRequest(
          ctx.log,
          {
            requestId: ctx.requestId,
            sessionId,
            namespace,
            method: 'tools/call',
            userId: session.userId,
            latencyMs,
            outcomeClass: OutcomeClass.ToolError,
          },
          'tool execution denied: not visible'
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
              `then call gateway_call_tool with the tool name ('${toolName}') and its serverId to execute it. ` +
              'Do not call downstream tools directly.'
          )
        }
        throw new GatewayError(GatewayErrorCode.TOOL_NOT_VISIBLE)
      }
      if (outcome.error === 'AMBIGUOUS_TOOL_NAME') {
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
      logRequest(
        ctx.log,
        {
          requestId: ctx.requestId,
          sessionId,
          namespace,
          method: 'tools/call',
          userId: session.userId,
          downstreamServer: outcome.serverId,
          latencyMs,
          outcomeClass: OutcomeClass.ToolError,
        },
        'tool error'
      )
      return {
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32000, message: outcome.error ?? 'Tool execution error' },
      }

    case OutcomeClass.UnavailableDownstream:
      throw new GatewayError(GatewayErrorCode.DOWNSTREAM_UNAVAILABLE)

    case OutcomeClass.Timeout:
      throw new GatewayError(GatewayErrorCode.DOWNSTREAM_TIMEOUT)

    case OutcomeClass.TransportError:
      throw new GatewayError(GatewayErrorCode.DOWNSTREAM_UNAVAILABLE, outcome.error)

    case OutcomeClass.AuthError:
      throw new GatewayError(GatewayErrorCode.SESSION_NOT_FOUND)

    default:
      throw new GatewayError(GatewayErrorCode.INTERNAL_GATEWAY_ERROR)
  }
}
