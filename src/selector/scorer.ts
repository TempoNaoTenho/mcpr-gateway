import { DownstreamHealth, Mode, OutcomeClass, SourceTrustLevel, ToolRiskLevel } from '../types/enums.js'
import type { Toolcard } from '../types/tools.js'
import type { ExecutionOutcome } from '../types/execution.js'
import { tokenize } from '../candidate/lexical.js'
import { inferCapabilityFromTool, resolveFocusFromOutcomes } from './focus.js'
import { rankToolsHybrid } from './hybrid.js'

export type RerankSignals = {
  mode: Mode
  penalties: {
    write: number
    admin: number
    unhealthyDownstream: number
  }
  healthStates: Record<string, DownstreamHealth>
  recentOutcomes: ExecutionOutcome[]
  initialIntentText?: string
  starterPackHints: string[]
  namespace: string
  lexicalEnabled?: boolean
  focus?: {
    enabled?: boolean
    lookback?: number
    minDominantSuccesses?: number
    crossDomainPenalty?: number
  }
}

export type RerankEntry = {
  toolcard: Toolcard
  score: number
  breakdown: Record<string, number>
}

export function rerankCandidates(
  candidates: Toolcard[],
  signals: RerankSignals,
): RerankEntry[] {
  const focus = resolveFocusFromOutcomes(signals.recentOutcomes, signals.focus)
  const crossDomainPenalty = signals.focus?.crossDomainPenalty ?? 1
  const hybridByKey = new Map(
    rankToolsHybrid(candidates, {
      namespace: signals.namespace,
      starterPackHints: signals.starterPackHints,
      recentOutcomes: signals.recentOutcomes,
      initialIntentText: signals.initialIntentText,
      focus: signals.focus,
      lexicalEnabled: signals.lexicalEnabled,
    }).map((entry) => [`${entry.toolcard.serverId}::${entry.toolcard.name}`, entry]),
  )
  const entries: RerankEntry[] = candidates.map((tc) => {
    const hybrid = hybridByKey.get(`${tc.serverId}::${tc.name}`)
    const breakdown: Record<string, number> = { ...(hybrid?.breakdown ?? {}) }
    let score = hybrid?.score ?? 0

    // Trust bonus
    const trustBonus =
      tc.sourceTrust === SourceTrustLevel.Internal
        ? 1
        : tc.sourceTrust === SourceTrustLevel.Verified
          ? 0.5
          : 0
    if (trustBonus > 0) {
      breakdown.trustBonus = trustBonus
      score += trustBonus
    }

    // Health penalty — scale by unhealthyDownstream; 0.5 preserves legacy magnitude
    const unhealthyScale = signals.penalties.unhealthyDownstream / 0.5
    const health = signals.healthStates[tc.serverId]
    const baseHealthPenalty =
      health === DownstreamHealth.Degraded
        ? -2
        : health === DownstreamHealth.Offline
          ? -5
          : health === DownstreamHealth.Unknown
            ? -0.5
            : 0
    const healthPenalty =
      baseHealthPenalty !== 0 ? baseHealthPenalty * unhealthyScale : 0
    if (healthPenalty !== 0) {
      breakdown.healthPenalty = healthPenalty
      score += healthPenalty
    }

    // Latency penalty
    if (tc.estimatedLatency !== undefined && tc.estimatedLatency > 0) {
      const latencyPenalty = -Math.floor(tc.estimatedLatency / 1000)
      if (latencyPenalty !== 0) {
        breakdown.latencyPenalty = latencyPenalty
        score += latencyPenalty
      }
    }

    // Failure penalty — max -6, -2 per recent failure
    const toolFailures = signals.recentOutcomes.filter(
      (o) => o.toolName === tc.name && o.serverId === tc.serverId && o.outcome !== OutcomeClass.Success,
    )
    if (toolFailures.length > 0) {
      const failurePenalty = Math.max(-6, toolFailures.length * -2)
      breakdown.failurePenalty = failurePenalty
      score += failurePenalty
    }

    // Mode penalty: Read mode + High risk (write); Admin mode + High risk (admin)
    if (signals.mode === Mode.Read && tc.riskLevel === ToolRiskLevel.High) {
      const modePenalty = -(signals.penalties.write * 5)
      if (modePenalty !== 0) {
        breakdown.modePenalty = modePenalty
        score += modePenalty
      }
    }
    if (signals.mode === Mode.Admin && tc.riskLevel === ToolRiskLevel.High) {
      const adminModePenalty = -(signals.penalties.admin * 5)
      if (adminModePenalty !== 0) {
        breakdown.adminModePenalty = adminModePenalty
        score += adminModePenalty
      }
    }

    if (focus.dominantCapability) {
      const capability = inferCapabilityFromTool(tc)
      if (capability === focus.dominantCapability) {
        breakdown.focusBonus = 1.5
        score += 1.5
      } else if (capability !== 'misc') {
        breakdown.focusPenalty = -crossDomainPenalty
        score -= crossDomainPenalty
      }
    }

    return { toolcard: tc, score, breakdown }
  })

  // Initial sort by score desc for redundancy detection
  entries.sort((a, b) => {
    const diff = b.score - a.score
    if (diff !== 0) return diff
    return a.toolcard.name.localeCompare(b.toolcard.name)
  })

  // Redundancy penalty — -1 for each subsequent tool sharing the same first token
  const seenFirstTokens = new Map<string, number>()
  for (const entry of entries) {
    const firstToken = tokenize(entry.toolcard.name)[0]
    if (firstToken) {
      const count = seenFirstTokens.get(firstToken) ?? 0
      if (count > 0) {
        entry.breakdown.redundancyPenalty = -1
        entry.score -= 1
      }
      seenFirstTokens.set(firstToken, count + 1)
    }
  }

  // Re-sort after redundancy penalty
  entries.sort((a, b) => {
    const diff = b.score - a.score
    if (diff !== 0) return diff
    return a.toolcard.name.localeCompare(b.toolcard.name)
  })

  return entries
}
