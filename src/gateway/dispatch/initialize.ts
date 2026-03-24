import { nanoid } from 'nanoid'
import type { FastifyRequest } from 'fastify'
import { SessionIdSchema } from '../../types/identity.js'
import { SessionStatus, Mode, RefreshTriggerType, ToolRiskLevel } from '../../types/enums.js'
import { GatewayError } from '../../types/errors.js'
import { getConfig } from '../../config/index.js'
import { resolveIdentity } from '../../auth/index.js'
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

interface JsonRpcBody {
  jsonrpc: string
  id: number | string | null
  method: string
  params?: Record<string, unknown>
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
  request: FastifyRequest,
  body: JsonRpcBody,
  store: ISessionStore,
  registry: DownstreamRegistry,
  auditLogger?: IAuditLogger,
): Promise<{ id: string; result: unknown }> {
  const startMs = Date.now()
  const config = getConfig()
  const identity = resolveIdentity(request.headers.authorization, config.auth)
  const namespace = (request.params as { namespace: string }).namespace
  const requestedMode = (body.params?.mode as Mode | undefined) ?? Mode.Read
  const initialIntentText = normalizeInitializeIntent(body.params)

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

  // Resolve starter pack from config using starterPackKey
  const starterPackKey = decision.starterPackKey
  const starterPack = starterPackKey ? config.starterPacks[starterPackKey] : undefined

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
    disabledToolKeys: disabledToolKeysForNamespace(config, namespace),
  }
  const { pool } = buildCandidatePool(candidateInput)

  const bootstrapWindow = buildBootstrapWindowFromConfig(
    pool,
    config,
    namespace,
    requestedMode,
  )
  const selectorDecision = {
    selected: bootstrapWindow,
    reasoning: 'bootstrap_window',
    triggeredBy: RefreshTriggerType.ExplicitRequest,
    timestamp: now,
  }

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
  const session = {
    id: sessionId,
    userId: identity.sub,
    namespace,
    mode: requestedMode,
    status: SessionStatus.Active,
    toolWindow: buildGatewayToolWindowForMode(namespace, namespacePolicy.gatewayMode),
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
    toolCount: bootstrapWindow.length,
    triggerUsed: RefreshTriggerType.ExplicitRequest,
    timestamp: now,
  })

  logRequest(request.log, {
    requestId: request.id,
    sessionId,
    namespace,
    method: 'initialize',
    userId: identity.sub,
    latencyMs,
  }, 'session initialized')

  return {
    id: sessionId,
    result: {
      jsonrpc: '2.0',
      id: body.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
        serverInfo: {
          name: 'mcp-session-gateway',
          version: '0.1.0',
        },
      },
    },
  }
}
