import { DownstreamHealth } from '../types/enums.js'
import type { Toolcard } from '../types/tools.js'
import type { CandidateInput, CandidateDebugEntry } from '../types/candidate.js'
import { toolCandidateKey } from './lexical.js'

export function applyHardFilters(
  toolcards: Toolcard[],
  input: CandidateInput,
): { passed: Toolcard[]; debug: CandidateDebugEntry[] } {
  const passed: Toolcard[] = []
  const debug: CandidateDebugEntry[] = []

  for (const tc of toolcards) {
    if (tc.quarantined === true) {
      debug.push({ toolName: tc.name, serverId: tc.serverId, score: 0, included: false, filterReason: 'quarantined' })
      continue
    }

    if (tc.namespace !== input.namespace) {
      debug.push({ toolName: tc.name, serverId: tc.serverId, score: 0, included: false, filterReason: 'namespace mismatch' })
      continue
    }

    if (!input.includeRiskLevels.includes(tc.riskLevel)) {
      debug.push({
        toolName: tc.name,
        serverId: tc.serverId,
        score: 0,
        included: false,
        filterReason: 'risk level not allowed',
      })
      continue
    }

    if (input.healthStates?.[tc.serverId] === DownstreamHealth.Offline) {
      debug.push({ toolName: tc.name, serverId: tc.serverId, score: 0, included: false, filterReason: 'server offline' })
      continue
    }

    if (input.disabledToolKeys.size > 0 && input.disabledToolKeys.has(toolCandidateKey(tc.serverId, tc.name))) {
      debug.push({
        toolName: tc.name,
        serverId: tc.serverId,
        score: 0,
        included: false,
        filterReason: 'disabled in namespace',
      })
      continue
    }

    passed.push(tc)
    debug.push({ toolName: tc.name, serverId: tc.serverId, score: 0, included: true })
  }

  return { passed, debug }
}
