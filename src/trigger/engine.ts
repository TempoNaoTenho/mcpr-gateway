import { OutcomeClass, RefreshTriggerType, ToolRiskLevel, AuditEventType } from '../types/enums.js'
import type { ISessionStore, ISelectorEngine, IAuditLogger } from '../types/interfaces.js'
import type { DownstreamRegistry } from '../registry/registry.js'
import type { ExecutionOutcome } from '../types/execution.js'
import type { SessionState } from '../types/session.js'
import type { SessionId } from '../types/identity.js'
import type { TriggerPolicy } from '../config/schemas.js'
import { getConfig } from '../config/index.js'
import { generateToolcards } from '../toolcard/index.js'
import { buildCandidatePool } from '../candidate/index.js'
import { buildGatewayToolWindowForMode, isGatewayInternalTool } from '../gateway/discovery.js'
import { GatewayMode } from '../types/enums.js'
import { resolveFocusFromOutcomes } from '../selector/focus.js'
import { disabledToolKeysForNamespace } from '../config/disabled-tool-keys.js'
import { buildVisibleToolCatalog } from '../session/catalog.js'

export class TriggerEngine {
  constructor(
    private store: ISessionStore,
    private registry: DownstreamRegistry,
    private selector: ISelectorEngine,
    private auditLogger?: IAuditLogger,
  ) {}

  async evaluate(sessionId: SessionId, outcome: ExecutionOutcome): Promise<void> {
    const session = await this.store.get(sessionId)
    if (!session) return

    const config = getConfig()
    const triggerPolicy = config.triggers

    // Check cooldown
    if (session.refreshHistory.length > 0) {
      const lastRefresh = session.refreshHistory[session.refreshHistory.length - 1]
      const lastRefreshTime = new Date(lastRefresh.timestamp).getTime()
      const cooldownMs = triggerPolicy.cooldownSeconds * 1000
      if (Date.now() - lastRefreshTime < cooldownMs) return
    }

    const triggerType = this.determineTrigger(outcome, session, triggerPolicy)
    if (triggerType === null) return

    await this.refresh(session, triggerType)
  }

  private determineTrigger(
    outcome: ExecutionOutcome,
    session: SessionState,
    policy: TriggerPolicy,
  ): RefreshTriggerType | null {
    if (isGatewayInternalTool(outcome.toolName, outcome.serverId)) {
      return null
    }

    if (
      outcome.outcome === OutcomeClass.Success &&
      policy.refreshOnSuccess &&
      this.isFirstSuccessInDomain(outcome, session)
    ) {
      return RefreshTriggerType.FirstSuccessInDomain
    }

    if (outcome.outcome === OutcomeClass.Timeout && policy.refreshOnTimeout) {
      return RefreshTriggerType.ErrorThreshold
    }

    if (
      ((outcome.outcome === OutcomeClass.ToolError && outcome.serverId !== '') ||
      (outcome.outcome === OutcomeClass.UnavailableDownstream ||
        outcome.outcome === OutcomeClass.TransportError)) &&
      policy.refreshOnError
    ) {
      return RefreshTriggerType.ErrorThreshold
    }

    return null
  }

  private isFirstSuccessInDomain(outcome: ExecutionOutcome, session: SessionState): boolean {
    const matchingSuccesses = session.recentOutcomes.filter(
      (o) => o.outcome === OutcomeClass.Success && o.serverId === outcome.serverId,
    )

    if (matchingSuccesses.length === 0) {
      return true
    }

    return (
      matchingSuccesses.length === 1 && this.isSameOutcome(matchingSuccesses[0]!, outcome)
    )
  }

  private isSameOutcome(left: ExecutionOutcome, right: ExecutionOutcome): boolean {
    return (
      left.toolName === right.toolName &&
      left.serverId === right.serverId &&
      left.sessionId === right.sessionId &&
      left.outcome === right.outcome &&
      left.durationMs === right.durationMs &&
      left.timestamp === right.timestamp
    )
  }

  private async refresh(session: SessionState, triggerType: RefreshTriggerType): Promise<void> {
    const config = getConfig()
    const triggerPolicy = config.triggers

    const serverGroups = this.registry.getToolsByNamespace(session.namespace)
    const toolcards = serverGroups.flatMap(({ server, records }) =>
      generateToolcards(records, server, server.toolOverrides),
    )
    const healthStates = this.registry.getHealthStates()

    const starterPackKey = session.resolvedPolicy?.starterPackKey
    const starterPack = starterPackKey ? config.starterPacks[starterPackKey] : undefined

    const namespacePolicy = (session.resolvedPolicy?.namespacePolicy ?? {}) as Record<
      string,
      unknown
    >
    const gatewayMode = namespacePolicy['gatewayMode'] === GatewayMode.Code
      ? GatewayMode.Code
      : namespacePolicy['gatewayMode'] === GatewayMode.Default
        ? GatewayMode.Default
        : GatewayMode.Compat
    const candidatePoolSize =
      typeof namespacePolicy['candidatePoolSize'] === 'number'
        ? namespacePolicy['candidatePoolSize']
        : 20
    const disabledToolKeys = disabledToolKeysForNamespace(config, session.namespace)
    const { pool } = buildCandidatePool({
      namespace: session.namespace,
      mode: session.mode,
      candidatePoolSize,
      currentToolWindow: session.toolWindow,
      recentOutcomes: session.recentOutcomes,
      initialIntentText: session.initialIntentText,
      starterPackHints: starterPack?.preferredTags ?? [],
      includeRiskLevels: starterPack?.includeRiskLevels ?? [ToolRiskLevel.Low],
      allToolcards: toolcards,
      healthStates,
      disabledToolKeys,
    })

    if (gatewayMode === GatewayMode.Default) {
      const now = new Date().toISOString()
      const directCatalog = buildVisibleToolCatalog(toolcards, disabledToolKeys)
      const focus = resolveFocusFromOutcomes(session.recentOutcomes, config.selector.focus)
      const updatedSession: SessionState = {
        ...session,
        toolWindow: directCatalog,
        refreshCount: session.refreshCount + 1,
        lastSelectorDecision: {
          selected: directCatalog,
          reasoning: 'direct_catalog',
          triggeredBy: triggerType,
          timestamp: now,
        },
        focusProfile: {
          dominantCapability: focus.dominantCapability,
          recentCapabilities: focus.recentCapabilities,
          totalSignals: focus.totalSignals,
          updatedAt: now,
        },
        pendingToolListChange: true,
        refreshHistory: [
          ...session.refreshHistory,
          {
            triggeredBy: triggerType,
            timestamp: now,
            toolCount: directCatalog.length,
          },
        ],
      }

      await this.store.set(session.id as SessionId, updatedSession)

      this.auditLogger?.emit({
        type: AuditEventType.ActiveWindowRecomputed,
        sessionId: session.id,
        toolCount: directCatalog.length,
        triggerUsed: triggerType,
        timestamp: now,
      })
      return
    }

    const decision = await this.selector.select({
      sessionId: session.id,
      namespace: session.namespace,
      mode: session.mode,
      candidates: pool,
      policyConfig: {
        selector: config.selector,
        triggeredBy: triggerType,
      },
      recentOutcomes: session.recentOutcomes,
      initialIntentText: session.initialIntentText,
      healthStates,
      currentWindow: session.toolWindow,
      starterPackHints: starterPack?.preferredTags ?? [],
    })

    let newWindow
    if (triggerPolicy.replaceOrAppend === 'append') {
      const existingKeys = new Set(
        session.toolWindow
          .filter((tool) => !isGatewayInternalTool(tool.name, tool.serverId))
          .map((t) => `${t.serverId}:${t.name}`),
      )
      const incoming = decision.selected.filter((t) => !existingKeys.has(`${t.serverId}:${t.name}`))
      const combined = [
        ...session.toolWindow.filter((tool) => !isGatewayInternalTool(tool.name, tool.serverId)),
        ...incoming,
      ]
      newWindow = combined
    } else {
      newWindow = decision.selected
    }

    const now = new Date().toISOString()
    const focus = resolveFocusFromOutcomes(session.recentOutcomes, config.selector.focus)
    const updatedSession: SessionState = {
      ...session,
      toolWindow: buildGatewayToolWindowForMode(session.namespace, gatewayMode),
      refreshCount: session.refreshCount + 1,
      lastSelectorDecision: decision,
      focusProfile: {
        dominantCapability: focus.dominantCapability,
        recentCapabilities: focus.recentCapabilities,
        totalSignals: focus.totalSignals,
        updatedAt: now,
      },
      pendingToolListChange: true,
      refreshHistory: [
        ...session.refreshHistory,
        {
          triggeredBy: triggerType,
          timestamp: now,
          toolCount: buildGatewayToolWindowForMode(session.namespace, gatewayMode).length,
        },
      ],
    }

    await this.store.set(session.id as SessionId, updatedSession)

    this.auditLogger?.emit({
      type: AuditEventType.ActiveWindowRecomputed,
      sessionId: session.id,
      toolCount: newWindow.length,
      triggerUsed: triggerType,
      timestamp: now,
    })
  }
}
