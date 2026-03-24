import { RefreshTriggerType } from '../types/enums.js'
import type { ISelectorEngine, IHealthMonitor } from '../types/interfaces.js'
import type { SelectorInput, SelectorDecision } from '../types/selector.js'
import type { Toolcard } from '../types/tools.js'
import { rerankCandidates } from './scorer.js'
import { publishWindow } from './publish.js'
import { resolveFocusFromOutcomes } from './focus.js'
import { rankToolsWithBm25 } from './bm25.js'

type PolicyConfig = {
  selector?: {
    lexical?: { enabled?: boolean }
    penalties?: {
      write?: number
      admin?: number
      unhealthyDownstream?: number
    }
    focus?: {
      enabled?: boolean
      lookback?: number
      minDominantSuccesses?: number
      reserveSlots?: number
      crossDomainPenalty?: number
    }
  }
  triggeredBy?: RefreshTriggerType
}

export class SelectorEngine implements ISelectorEngine {
  constructor(private readonly healthMonitor?: IHealthMonitor) {}

  async select(input: SelectorInput): Promise<SelectorDecision> {
    const policy = input.policyConfig as PolicyConfig

    const liveHealthStates = this.healthMonitor?.getAllStates() ?? {}
    const healthStates = Object.keys(liveHealthStates).length > 0
      ? liveHealthStates
      : (input.healthStates ?? {})

    const ranked = rerankCandidates(input.candidates, {
      mode: input.mode,
      penalties: {
        write: policy.selector?.penalties?.write ?? 0.5,
        admin: policy.selector?.penalties?.admin ?? 0.5,
        unhealthyDownstream: policy.selector?.penalties?.unhealthyDownstream ?? 0.5,
      },
      healthStates,
      recentOutcomes: input.recentOutcomes ?? [],
      initialIntentText: input.initialIntentText,
      starterPackHints: input.starterPackHints ?? [],
      namespace: input.namespace,
      lexicalEnabled: policy.selector?.lexical?.enabled,
      focus: policy.selector?.focus,
    })

    const triggeredBy = policy.triggeredBy ?? RefreshTriggerType.ExplicitRequest
    const focus = resolveFocusFromOutcomes(input.recentOutcomes ?? [], policy.selector?.focus)
    const effectiveWindowSize = ranked.length
    const { selected, reasoning, exclusions } = publishWindow(
      ranked,
      effectiveWindowSize,
      input.currentWindow ?? [],
      {
        dominantCapability: focus.dominantCapability,
        reserveSlots: policy.selector?.focus?.reserveSlots ?? 0,
      },
    )

    const trace = {
      candidatePoolSize: input.candidates.length,
      filtersApplied: ['namespace', 'mode', 'health'],
      penaltiesApplied: {
        write: policy.selector?.penalties?.write ?? 0.5,
        admin: policy.selector?.penalties?.admin ?? 0.5,
        unhealthyDownstream: policy.selector?.penalties?.unhealthyDownstream ?? 0.5,
      },
      exclusionReasons: exclusions,
      focus: {
        dominantCapability: focus.dominantCapability,
        reserveSlots: policy.selector?.focus?.reserveSlots ?? 0,
      },
      rankedList: ranked.map((e) => ({
        toolName: e.toolcard.name,
        serverId: e.toolcard.serverId,
        score: e.score,
        breakdown: e.breakdown,
      })),
      windowSizeUsed: effectiveWindowSize,
      triggerUsed: triggeredBy,
    }

    return {
      selected,
      reasoning,
      triggeredBy,
      timestamp: new Date().toISOString(),
      trace,
    }
  }

  async rerank(tools: Toolcard[], query: string): Promise<Toolcard[]> {
    return rankToolsWithBm25(tools, query).map((entry) => entry.toolcard)
  }
}
