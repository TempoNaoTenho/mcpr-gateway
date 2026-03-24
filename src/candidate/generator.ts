import { OutcomeClass } from '../types/enums.js'
import type { CandidateInput, CandidateResult } from '../types/candidate.js'
import { applyHardFilters } from './filters.js'
import { toolCandidateKey } from './lexical.js'
import { rankToolsHybrid } from '../selector/hybrid.js'

export function buildCandidatePool(input: CandidateInput): CandidateResult {
  const { passed, debug } = applyHardFilters(input.allToolcards, input)

  // Build a map from candidate key → debug index for passed tools
  const debugIndexByKey = new Map<string, number>()
  for (let i = 0; i < debug.length; i++) {
    debugIndexByKey.set(toolCandidateKey(debug[i].serverId, debug[i].toolName), i)
  }

  const successOutcomes = input.recentOutcomes.filter((o) => o.outcome === OutcomeClass.Success)
  const ranked = rankToolsHybrid(passed, {
    namespace: input.namespace,
    starterPackHints: input.starterPackHints,
    recentOutcomes: successOutcomes,
    initialIntentText: input.initialIntentText,
  })

  // Score each passed tool
  for (const { toolcard, score, breakdown } of ranked) {
    const idx = debugIndexByKey.get(toolCandidateKey(toolcard.serverId, toolcard.name))
    if (idx !== undefined) {
      debug[idx].score = score
      debug[idx].scoreBreakdown = Object.keys(breakdown).length > 0 ? breakdown : undefined
    }
  }

  // Sort passed by score desc, then name asc for tie-breaking
  const sorted = [...passed].sort((a, b) => {
    const aIdx = debugIndexByKey.get(toolCandidateKey(a.serverId, a.name))!
    const bIdx = debugIndexByKey.get(toolCandidateKey(b.serverId, b.name))!
    const scoreDiff = debug[bIdx].score - debug[aIdx].score
    if (scoreDiff !== 0) return scoreDiff
    const nameDiff = a.name.localeCompare(b.name)
    if (nameDiff !== 0) return nameDiff
    return a.serverId.localeCompare(b.serverId)
  })

  const pool = sorted.slice(0, input.candidatePoolSize)
  const poolKeys = new Set(pool.map((tc) => toolCandidateKey(tc.serverId, tc.name)))

  // Mark tools excluded by pool size threshold
  for (const entry of debug) {
    if (entry.included && !poolKeys.has(toolCandidateKey(entry.serverId, entry.toolName))) {
      entry.included = false
      entry.filterReason = 'below pool size threshold'
    }
  }

  return { pool, debug }
}
