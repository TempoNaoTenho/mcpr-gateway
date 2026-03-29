import { nanoid } from 'nanoid'
import { SessionIdSchema } from '../../types/identity.js'
import type { SelectorDecision } from '../../types/selector.js'
import { SessionStatus, Mode, RefreshTriggerType, ToolRiskLevel, GatewayMode } from '../../types/enums.js'
import { GatewayError, GatewayErrorCode } from '../../types/errors.js'
import { getConfig } from '../../config/index.js'
import { buildOAuthChallenge } from '../../auth/oauth-challenge.js'
import { getInboundOAuth } from '../../auth/oauth-config.js'
import { resolveMcpIdentityForInitialize } from '../../auth/mcp-identity.js'
import { resolvePolicy } from '../../policy/index.js'
import { generateToolcards } from '../../toolcard/index.js'
import { buildCandidatePool } from '../../candidate/index.js'
import { buildBootstrapWindowFromConfig } from '../../session/bootstrap.js'
import type { CandidateInput } from '../../types/candidate.js'
import type { ISessionStore, IAuditLogger } from '../../types/interfaces.js'
import type { DownstreamRegistry } from '../../registry/registry.js'
import { AuditEventType } from '../../types/enums.js'
import { logRequest } from '../../observability/structured-log.js'
import { buildGatewayToolWindowForMode } from '../discovery.js'
import { resolveFocusFromOutcomes } from '../../selector/focus.js'
import { disabledToolKeysForNamespace } from '../../config/disabled-tool-keys.js'
import { buildVisibleToolCatalog } from '../../session/catalog.js'
import type { McpHandlerContext } from '../mcp-handler-context.js'
import type { JsonRpcBody } from '../jsonrpc.js'
import { negotiateMcpProtocolVersion } from '../mcp-protocol-version.js'

/** Same string the MCP client receives in `initialize.result.instructions` (compat/code only). */
export function buildGatewayInstructions(mode: GatewayMode, serverIds: string[]): string | undefined {
  switch (mode) {
    case GatewayMode.Compat: {
      const serverList =
        serverIds.length > 0
          ? ` Available servers: [${serverIds.map((id) => `"${id}"`).join(', ')}].`
          : ''
      return `Gateway in compatibility mode. Discover available tools with gateway_search_tools, then invoke them with gateway_call_tool using the exact name and serverId returned by the search result. Do not guess aliases, historical names, or call upstream tools directly.${serverList}`
    }
    case GatewayMode.Code:
      return 'Gateway in code mode. Use gateway_run_code to execute JavaScript. Available sandbox APIs: catalog.search(query, { k | limit, serverId, requiredArgs }), catalog.list({ serverId, requiredArgs }), catalog.describe(handle, { detail }), mcp.call(handle, args), mcp.batch([{handle, args}]), result.limit(array, n), result.items(value), result.text(value), result.pick(fields), artifacts.save(data, { label }). Handles returned by catalog.* are session-scoped and should be used from the current execution only. `detail: "signature"` includes required args plus short field metadata. For batch calls, prefer handles filtered by requiredArgs, inspect them with catalog.describe(), and check the result count before indexing tools[1]. The `result` global is reserved, `result.limit()` expects an array such as `out.content`, and returned values should be serializable. Call gateway_help for full API reference.'
    default:
      return undefined
  }
}

function normalizeInitializeIntent(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined

  const parts = ['intent', 'goal', 'query', 'taskContext']
    .map((key) => params[key])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  if (parts.length === 0) return undefined
  return [...new Set(parts)].join(' ')
}

export async function handleInitialize(
  ctx: McpHandlerContext,
  body: JsonRpcBody,
  store: ISessionStore,
  registry: DownstreamRegistry,
  auditLogger?: IAuditLogger,
): Promise<{ id: string; negotiatedProtocolVersion: string; result: unknown }> {
  const startMs = Date.now()
  const config = getConfig()
  const namespace = ctx.namespace
  const nsKeys = new Set(Object.keys(config.namespaces))
  const idResult = await resolveMcpIdentityForInitialize(
    ctx.authorization,
    config.auth,
    namespace,
    nsKeys,
  )

  if (idResult.kind === 'oauth_required') {
    const oauth = getInboundOAuth(config.auth)
    if (!oauth) {
      throw new GatewayError(GatewayErrorCode.INTERNAL_GATEWAY_ERROR)
    }
    const { wwwAuthenticate } = buildOAuthChallenge(oauth, namespace)
    throw new GatewayError(GatewayErrorCode.OAUTH_AUTHENTICATION_REQUIRED, undefined, undefined, {
      'WWW-Authenticate': wwwAuthenticate,
    })
  }

  if (idResult.kind === 'oauth_invalid') {
    const oauth = getInboundOAuth(config.auth)
    if (!oauth) {
      throw new GatewayError(GatewayErrorCode.INTERNAL_GATEWAY_ERROR)
    }
    const { wwwAuthenticate } = buildOAuthChallenge(oauth, namespace, 'invalid_token')
    throw new GatewayError(GatewayErrorCode.OAUTH_INVALID_TOKEN, undefined, undefined, {
      'WWW-Authenticate': wwwAuthenticate,
    })
  }

  const identity = idResult.identity
  const requestedMode = (body.params?.mode as Mode | undefined) ?? Mode.Read
  const initialIntentText = normalizeInitializeIntent(body.params)
  const negotiatedProtocolVersion = negotiateMcpProtocolVersion(body.params?.protocolVersion)

  const decision = resolvePolicy(identity, namespace, requestedMode, config)
  if (!decision.allowed) {
    throw new GatewayError(decision.rejectionCode!)
  }

  const namespacePolicy = decision.namespacePolicy!
  const rawId = nanoid()
  const sessionId = SessionIdSchema.parse(rawId)
  const now = new Date().toISOString()

  const serverGroups = registry.getToolsByNamespace(namespace)
  const toolcards = serverGroups.flatMap(({ server, records }) =>
    generateToolcards(records, server, server.toolOverrides),
  )
  const healthStates = registry.getHealthStates()
  const disabledToolKeys = disabledToolKeysForNamespace(config, namespace)

  // Resolve starter pack from config using starterPackKey
  const starterPackKey = decision.starterPackKey
  const starterPack = starterPackKey ? config.starterPacks[starterPackKey] : undefined

  const clientCaps = body.params?.capabilities as
    | {
        tools?: { listChanged?: boolean; list_changed?: boolean }
        experimental?: { toolListChanged?: boolean }
      }
    | undefined
  const supportsToolListChanged =
    clientCaps?.tools?.listChanged === true ||
    clientCaps?.tools?.list_changed === true ||
    clientCaps?.experimental?.toolListChanged === true

  const focus = resolveFocusFromOutcomes([], config.selector.focus)
  const gatewayMode =
    namespacePolicy.gatewayMode === GatewayMode.Code
      ? GatewayMode.Code
      : namespacePolicy.gatewayMode === GatewayMode.Default
        ? GatewayMode.Default
        : GatewayMode.Compat
  const directCatalog = buildVisibleToolCatalog(toolcards, disabledToolKeys)

  let selectorDecision: SelectorDecision
  if (gatewayMode === GatewayMode.Default) {
    selectorDecision = {
      selected: directCatalog,
      reasoning: 'direct_catalog',
      triggeredBy: RefreshTriggerType.ExplicitRequest,
      timestamp: now,
    }
  } else {
    // Phase 8: build candidate pool
    const candidateInput: CandidateInput = {
      namespace,
      mode: requestedMode,
      candidatePoolSize: namespacePolicy.candidatePoolSize,
      currentToolWindow: [],
      recentOutcomes: [],
      initialIntentText,
      starterPackHints: starterPack?.preferredTags ?? [],
      includeRiskLevels: starterPack?.includeRiskLevels ?? [ToolRiskLevel.Low],
      allToolcards: toolcards,
      healthStates,
      disabledToolKeys,
    }
    const { pool } = buildCandidatePool(candidateInput)

    const bootstrapWindow = buildBootstrapWindowFromConfig(
      pool,
      config,
      namespace,
      requestedMode,
    )
    selectorDecision = {
      selected: bootstrapWindow,
      reasoning: 'bootstrap_window',
      triggeredBy: RefreshTriggerType.ExplicitRequest,
      timestamp: now,
    }
  }
  const session = {
    id: sessionId,
    userId: identity.sub,
    namespace,
    mode: requestedMode,
    status: SessionStatus.Active,
    toolWindow:
      gatewayMode === GatewayMode.Default
        ? directCatalog
        : buildGatewayToolWindowForMode(namespace, gatewayMode),
    createdAt: now,
    lastActiveAt: now,
    refreshCount: 0,
    resolvedPolicy: {
      starterPackKey: decision.starterPackKey,
      namespacePolicy: (namespacePolicy as Record<string, unknown>) ?? {},
    },
    lastSelectorDecision: selectorDecision,
    recentOutcomes: [],
    initialIntentText,
    refreshHistory: [],
    focusProfile: {
      dominantCapability: focus.dominantCapability,
      recentCapabilities: focus.recentCapabilities,
      totalSignals: focus.totalSignals,
      updatedAt: now,
    },
    pendingToolListChange: false,
    clientCapabilities: { supportsToolListChanged },
    mcpProtocolVersion: negotiatedProtocolVersion,
  }

  await store.set(sessionId, session)

  const latencyMs = Date.now() - startMs

  auditLogger?.emit({
    type: AuditEventType.SessionCreated,
    sessionId,
    userId: identity.sub,
    namespace,
    timestamp: now,
  })

  auditLogger?.emit({
    type: AuditEventType.BootstrapWindowPublished,
    sessionId,
    toolCount: selectorDecision.selected.length,
    triggerUsed: RefreshTriggerType.ExplicitRequest,
    timestamp: now,
  })

  logRequest(ctx.log, {
    requestId: ctx.requestId,
    sessionId,
    namespace,
    method: 'initialize',
    userId: identity.sub,
    latencyMs,
  }, 'session initialized')

  const serverIds = serverGroups.map((g) => g.server.id)
  const instructions = buildGatewayInstructions(gatewayMode, serverIds)

  return {
    id: sessionId,
    negotiatedProtocolVersion,
    result: {
      jsonrpc: '2.0',
      id: body.id,
      result: {
        protocolVersion: negotiatedProtocolVersion,
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
        serverInfo: {
          name: 'mcpr-gateway',
          version: '0.1.0',
        },
        ...(instructions !== undefined && { instructions }),
      },
    },
  }
}
