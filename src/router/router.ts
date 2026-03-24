import { SessionStatus, OutcomeClass, DownstreamHealth, Mode, GatewayMode } from '../types/enums.js'
import type { SessionId } from '../types/identity.js'
import type {
  IExecutionRouter,
  IRegistryAdapter,
  ISessionStore,
  IHealthMonitor,
} from '../types/interfaces.js'
import type { DownstreamServer } from '../types/server.js'
import type { SessionState } from '../types/session.js'
import type { ExecutionOutcome } from '../types/execution.js'
import type { RateLimiter } from '../resilience/rateLimiter.js'
import { callToolHttp } from '../registry/transport/http.js'
import { callToolStdio } from '../registry/transport/stdio.js'
import { isDownstreamAuthError } from '../registry/auth/index.js'
import { getConfig } from '../config/index.js'
import { isToolDisabledForNamespace } from '../config/disabled-tool-keys.js'
import { executeCodeModeHelp, executeCodeMode } from '../runtime/index.js'
import {
  executeGatewayDiscovery,
  executeGatewaySearch,
  parseGatewayCallArgs,
  parseGatewayRunCodeArgs,
  GATEWAY_SERVER_ID,
  GATEWAY_DISCOVERY_TOOL_NAME,
  GATEWAY_SEARCH_TOOL_NAME,
  GATEWAY_CALL_TOOL_NAME,
  GATEWAY_RUN_CODE_TOOL_NAME,
  GATEWAY_HELP_TOOL_NAME,
  isGatewayInternalTool,
} from '../gateway/discovery.js'

// Keep deprecated alias for external consumers
/** @deprecated Use GATEWAY_SERVER_ID */
export { GATEWAY_SERVER_ID as GATEWAY_DISCOVERY_SERVER_ID } from '../gateway/discovery.js'

const MAX_RECENT_OUTCOMES = 50

function findVisibleToolsByName(
  toolWindow: Array<{ name: string; serverId: string }>,
  toolName: string
): Array<{ name: string; serverId: string }> {
  return toolWindow.filter((tool) => tool.name === toolName)
}

function isToolVisible(
  toolWindow: Array<{ name: string; serverId: string }>,
  toolName: string,
  serverId: string
): boolean {
  return toolWindow.some((tool) => tool.name === toolName && tool.serverId === serverId)
}

export class ExecutionRouter implements IExecutionRouter {
  constructor(
    private readonly registry: IRegistryAdapter,
    private readonly store: ISessionStore,
    private readonly healthMonitor?: IHealthMonitor,
    private readonly getRateLimiter?: () => RateLimiter | undefined,
    private readonly getResponseTimeoutMs?: () => number | undefined
  ) {}

  async resolveServer(
    toolName: string,
    sessionId: SessionId
  ): Promise<DownstreamServer | undefined> {
    const session = await this.store.get(sessionId)
    if (!session) return undefined

    const matches = findVisibleToolsByName(session.toolWindow, toolName)
    if (matches.length !== 1) return undefined

    return this.registry.getServer(matches[0]!.serverId)
  }

  async route(toolName: string, args: unknown, sessionId: SessionId): Promise<ExecutionOutcome> {
    const session = await this.store.get(sessionId)

    if (!session || session.status !== SessionStatus.Active) {
      return {
        toolName,
        serverId: '',
        sessionId,
        outcome: OutcomeClass.AuthError,
        error: 'Session not found or inactive',
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }
    }

    // Rate limiting (applies to all calls including gateway tools)
    const rateLimiter = this.getRateLimiter?.()

    if (rateLimiter) {
      if (!rateLimiter.checkSession(sessionId)) {
        return {
          toolName,
          serverId: '',
          sessionId,
          outcome: OutcomeClass.ToolError,
          error: 'RATE_LIMIT_EXCEEDED',
          durationMs: 0,
          timestamp: new Date().toISOString(),
        }
      }
      if (!rateLimiter.checkUser(session.userId)) {
        return {
          toolName,
          serverId: '',
          sessionId,
          outcome: OutcomeClass.ToolError,
          error: 'RATE_LIMIT_EXCEEDED',
          durationMs: 0,
          timestamp: new Date().toISOString(),
        }
      }
    }

    // --- Gateway internal tools (handled before visibility check) ---

    // gateway_search_tools — substring search across all tools
    if (
      toolName === GATEWAY_SEARCH_TOOL_NAME &&
      isToolVisible(session.toolWindow, GATEWAY_SEARCH_TOOL_NAME, GATEWAY_SERVER_ID)
    ) {
      const { result } = await executeGatewaySearch(session, args, this.registry)
      return {
        toolName,
        serverId: GATEWAY_SERVER_ID,
        sessionId,
        outcome: OutcomeClass.Success,
        result,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }
    }

    // gateway_call_tool — proxy to any downstream tool (bypasses visibility)
    if (
      toolName === GATEWAY_CALL_TOOL_NAME &&
      isToolVisible(session.toolWindow, GATEWAY_CALL_TOOL_NAME, GATEWAY_SERVER_ID)
    ) {
      return this.handleGatewayCall(session, sessionId, args, rateLimiter)
    }

    if (
      toolName === GATEWAY_RUN_CODE_TOOL_NAME &&
      isToolVisible(session.toolWindow, GATEWAY_RUN_CODE_TOOL_NAME, GATEWAY_SERVER_ID)
    ) {
      return this.handleGatewayRunCode(session, sessionId, args, rateLimiter)
    }

    if (
      toolName === GATEWAY_HELP_TOOL_NAME &&
      isToolVisible(session.toolWindow, GATEWAY_HELP_TOOL_NAME, GATEWAY_SERVER_ID)
    ) {
      const topic =
        args &&
        typeof args === 'object' &&
        !Array.isArray(args) &&
        typeof (args as Record<string, unknown>)['topic'] === 'string'
          ? ((args as Record<string, unknown>)['topic'] as string)
          : undefined
      const namespacePolicy = (session.resolvedPolicy?.namespacePolicy ?? {}) as Record<
        string,
        unknown
      >
      const gatewayMode: GatewayMode =
        namespacePolicy['gatewayMode'] === GatewayMode.Code
          ? GatewayMode.Code
          : namespacePolicy['gatewayMode'] === GatewayMode.Default
            ? GatewayMode.Default
            : GatewayMode.Compat
      return {
        toolName,
        serverId: GATEWAY_SERVER_ID,
        sessionId,
        outcome: OutcomeClass.Success,
        result: executeCodeModeHelp(topic, gatewayMode),
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }
    }

    // gateway_find_tools — legacy BM25 discovery
    if (
      toolName === GATEWAY_DISCOVERY_TOOL_NAME &&
      isToolVisible(session.toolWindow, GATEWAY_DISCOVERY_TOOL_NAME, GATEWAY_SERVER_ID)
    ) {
      const { updatedSession, result } = await executeGatewayDiscovery(
        session,
        args,
        this.registry,
        getConfig().selector
      )
      await this.store.set(sessionId, updatedSession)
      return {
        toolName,
        serverId: GATEWAY_SERVER_ID,
        sessionId,
        outcome: OutcomeClass.Success,
        result,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }
    }

    // --- Normal tool routing (visibility check) ---

    const matches = findVisibleToolsByName(session.toolWindow, toolName)
    if (matches.length === 0) {
      return {
        toolName,
        serverId: '',
        sessionId,
        outcome: OutcomeClass.ToolError,
        error: 'TOOL_NOT_VISIBLE',
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }
    }
    if (matches.length > 1) {
      return {
        toolName,
        serverId: '',
        sessionId,
        outcome: OutcomeClass.ToolError,
        error: 'AMBIGUOUS_TOOL_NAME',
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }
    }

    const [tool] = matches

    const liveConfig = getConfig()
    if (isToolDisabledForNamespace(liveConfig, session.namespace, tool.serverId, tool.name)) {
      return {
        toolName,
        serverId: '',
        sessionId,
        outcome: OutcomeClass.ToolError,
        error: 'TOOL_NOT_VISIBLE',
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }
    }

    const server = await this.registry.getServer(tool.serverId)
    if (!server || !server.enabled) {
      return {
        toolName,
        serverId: tool.serverId,
        sessionId,
        outcome: OutcomeClass.UnavailableDownstream,
        error: 'Downstream server is unavailable or disabled',
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }
    }

    return this.executeDownstream(server, toolName, args, session, sessionId, rateLimiter)
  }

  // ---------------------------------------------------------------------------
  // gateway_call_tool handler
  // ---------------------------------------------------------------------------

  private async handleGatewayCall(
    session: SessionState,
    sessionId: SessionId,
    args: unknown,
    rateLimiter: RateLimiter | undefined
  ): Promise<ExecutionOutcome> {
    const parsed = parseGatewayCallArgs(args)
    if ('error' in parsed) {
      return {
        toolName: GATEWAY_CALL_TOOL_NAME,
        serverId: GATEWAY_SERVER_ID,
        sessionId,
        outcome: OutcomeClass.ToolError,
        error: parsed.error,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }
    }

    // Check disabled
    const liveConfig = getConfig()
    if (isToolDisabledForNamespace(liveConfig, session.namespace, parsed.serverId, parsed.name)) {
      return {
        toolName: parsed.name,
        serverId: parsed.serverId,
        sessionId,
        outcome: OutcomeClass.ToolError,
        error: 'Tool is disabled for this namespace',
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }
    }

    // Resolve downstream server
    const server = await this.registry.getServer(parsed.serverId)
    if (!server || !server.enabled) {
      return {
        toolName: parsed.name,
        serverId: parsed.serverId,
        sessionId,
        outcome: OutcomeClass.UnavailableDownstream,
        error: 'Downstream server is unavailable or disabled',
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }
    }

    return this.executeDownstream(
      server,
      parsed.name,
      parsed.arguments,
      session,
      sessionId,
      rateLimiter
    )
  }

  private async handleGatewayRunCode(
    session: SessionState,
    sessionId: SessionId,
    args: unknown,
    rateLimiter: RateLimiter | undefined
  ): Promise<ExecutionOutcome> {
    const parsed = parseGatewayRunCodeArgs(args)
    if ('error' in parsed) {
      return {
        toolName: GATEWAY_RUN_CODE_TOOL_NAME,
        serverId: GATEWAY_SERVER_ID,
        sessionId,
        outcome: OutcomeClass.ToolError,
        error: parsed.error,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }
    }

    const startTime = Date.now()
    try {
      const result = await executeCodeMode(
        parsed.code,
        session,
        this.registry,
        getConfig().codeMode,
        async ({ serverId, name, args: toolArgs }) => {
          const server = await this.registry.getServer(serverId)
          if (!server || !server.enabled) {
            throw new Error(`Downstream server is unavailable or disabled: ${serverId}`)
          }
          const outcome = await this.executeDownstream(
            server,
            name,
            toolArgs,
            session,
            sessionId,
            rateLimiter
          )
          if (outcome.outcome !== OutcomeClass.Success) {
            throw new Error(outcome.error ?? outcome.outcome)
          }
          return outcome.result
        }
      )

      return {
        toolName: GATEWAY_RUN_CODE_TOOL_NAME,
        serverId: GATEWAY_SERVER_ID,
        sessionId,
        outcome: OutcomeClass.Success,
        result,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      }
    } catch (error) {
      return {
        toolName: GATEWAY_RUN_CODE_TOOL_NAME,
        serverId: GATEWAY_SERVER_ID,
        sessionId,
        outcome: OutcomeClass.ToolError,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Shared downstream execution (health check + concurrency + transport)
  // ---------------------------------------------------------------------------

  private async executeDownstream(
    server: DownstreamServer,
    toolName: string,
    args: unknown,
    session: SessionState,
    sessionId: SessionId,
    rateLimiter: RateLimiter | undefined
  ): Promise<ExecutionOutcome> {
    // Health check — fail-closed
    if (this.healthMonitor) {
      const healthState = this.healthMonitor.getState(server.id)
      if (healthState) {
        const status = healthState.status
        const mode = session.mode

        if (status === DownstreamHealth.Offline) {
          const outcome: ExecutionOutcome = {
            toolName,
            serverId: server.id,
            sessionId,
            outcome: OutcomeClass.UnavailableDownstream,
            error: 'Downstream server is offline',
            durationMs: 0,
            timestamp: new Date().toISOString(),
          }
          await this.persistOutcome(sessionId, outcome)
          return outcome
        }

        if (status === DownstreamHealth.Degraded && (mode === Mode.Write || mode === Mode.Admin)) {
          const outcome: ExecutionOutcome = {
            toolName,
            serverId: server.id,
            sessionId,
            outcome: OutcomeClass.UnavailableDownstream,
            error: 'Downstream server is degraded — write/admin operations not permitted',
            durationMs: 0,
            timestamp: new Date().toISOString(),
          }
          await this.persistOutcome(sessionId, outcome)
          return outcome
        }
      }
    }

    // Concurrency cap
    let releaseSlot: (() => void) | undefined
    if (rateLimiter) {
      const release = rateLimiter.acquireDownstream(server.id)
      if (release === null) {
        return {
          toolName,
          serverId: server.id,
          sessionId,
          outcome: OutcomeClass.UnavailableDownstream,
          error: 'Downstream concurrency limit reached',
          durationMs: 0,
          timestamp: new Date().toISOString(),
        }
      }
      releaseSlot = release
    }

    const startTime = Date.now()
    let callResult: { result?: unknown; error?: unknown }
    let outcomeClass: OutcomeClass

    try {
      if (server.transport === 'stdio') {
        callResult = await callToolStdio(server, toolName, args)
      } else {
        callResult = await callToolHttp(server, toolName, args, this.getResponseTimeoutMs?.())
      }

      if (callResult.error !== undefined) {
        outcomeClass = OutcomeClass.ToolError
      } else {
        outcomeClass = OutcomeClass.Success
      }
    } catch (err) {
      const durationMs = Date.now() - startTime
      const errMsg = err instanceof Error ? err.message : String(err)

      if (err instanceof Error && err.name === 'AbortError') {
        outcomeClass = OutcomeClass.Timeout
      } else if (isDownstreamAuthError(err)) {
        outcomeClass = OutcomeClass.AuthError
      } else if (errMsg.includes('HTTP ')) {
        outcomeClass = OutcomeClass.UnavailableDownstream
      } else {
        outcomeClass = OutcomeClass.TransportError
      }

      const outcome: ExecutionOutcome = {
        toolName,
        serverId: server.id,
        sessionId,
        outcome: outcomeClass,
        error: errMsg,
        durationMs,
        timestamp: new Date().toISOString(),
      }

      await this.persistOutcome(sessionId, outcome)
      return outcome
    } finally {
      releaseSlot?.()
    }

    const durationMs = Date.now() - startTime
    const outcome: ExecutionOutcome = {
      toolName,
      serverId: server.id,
      sessionId,
      outcome: outcomeClass,
      durationMs,
      timestamp: new Date().toISOString(),
      ...(outcomeClass === OutcomeClass.Success
        ? { result: callResult.result }
        : {
            error:
              typeof callResult.error === 'string'
                ? callResult.error
                : JSON.stringify(callResult.error),
          }),
    }

    await this.persistOutcome(sessionId, outcome)
    return outcome
  }

  private async persistOutcome(sessionId: SessionId, outcome: ExecutionOutcome): Promise<void> {
    if (isGatewayInternalTool(outcome.toolName, outcome.serverId)) {
      return
    }

    const session = await this.store.get(sessionId)
    if (!session) return

    const recentOutcomes = [...(session.recentOutcomes ?? []), outcome].slice(-MAX_RECENT_OUTCOMES)
    await this.store.set(sessionId, { ...session, recentOutcomes })
  }
}
