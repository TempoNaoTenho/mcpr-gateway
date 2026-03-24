import type { Mode, ToolRiskLevel, DownstreamHealth } from './enums.js'
import type { VisibleTool, Toolcard } from './tools.js'
import type { ExecutionOutcome } from './execution.js'

export type CandidateInput = {
  namespace: string
  mode: Mode
  candidatePoolSize: number
  currentToolWindow: VisibleTool[]
  recentOutcomes: ExecutionOutcome[]
  initialIntentText?: string
  starterPackHints: string[]
  includeRiskLevels: ToolRiskLevel[]
  allToolcards: Toolcard[]
  healthStates?: Record<string, DownstreamHealth>
  /** Tools whose keys are in this set are excluded from the candidate pool (namespace policy). */
  disabledToolKeys: ReadonlySet<string>
}

export type CandidateDebugEntry = {
  toolName: string
  serverId: string
  score: number
  included: boolean
  filterReason?: string
  scoreBreakdown?: Record<string, number>
}

export type CandidateResult = {
  pool: Toolcard[]
  debug: CandidateDebugEntry[]
}
