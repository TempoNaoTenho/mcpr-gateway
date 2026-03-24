import { OutcomeClass } from '../types/enums.js'
import type { ExecutionOutcome } from '../types/execution.js'
import type { Toolcard } from '../types/tools.js'
import { toolCandidateKey, tokenize } from '../candidate/lexical.js'
import { rankByBm25 } from './bm25.js'
import { inferCapabilityFromTool, resolveFocusFromOutcomes, type FocusConfig, type ToolCapability } from './focus.js'

const RRF_K = 60

const FIELD_WEIGHTS = {
  name: 3,
  tags: 2,
  serverId: 2,
  description: 1,
  context: 3,
} as const

const CAPABILITY_TERMS: Record<ToolCapability, string[]> = {
  files: ['file', 'files', 'path', 'directory'],
  git: ['git', 'repo', 'commit', 'branch'],
  browser: ['browser', 'page', 'web', 'navigate', 'extract', 'crawl'],
  docs: ['docs', 'documentation', 'api', 'reference', 'sdk', 'readme'],
  communication: ['email', 'message', 'chat', 'calendar'],
  ticketing: ['ticket', 'issue', 'incident', 'task'],
  observability: ['logs', 'metrics', 'traces', 'monitoring'],
  database: ['database', 'db', 'schema', 'query', 'table', 'sql'],
  search: ['search', 'find', 'lookup', 'retrieve', 'browse'],
  misc: [],
}

type RankedTool = {
  toolcard: Toolcard
  score: number
  breakdown: Record<string, number>
  matchedTerms: string[]
}

type SessionIntent = {
  query: string
  queryTerms: string[]
  hintTerms: string[]
  initialIntentTerms: string[]
  successfulToolKeys: Set<string>
  successfulServerIds: Set<string>
  recentToolNames: string[]
  dominantCapability?: ToolCapability
}

type ContextSignals = {
  exactRecentReuse: number
  recentServerAffinity: number
  starterPackAffinity: number
  initialIntentAffinity: number
  namespaceAffinity: number
  dominantCapabilityAffinity: number
  siblingAffinity: number
}

type FieldRankMap = {
  ranks: Map<string, number>
  matchedTerms: Map<string, string[]>
}

function toolTieBreaker(left: Toolcard, right: Toolcard): number {
  const nameDiff = left.name.localeCompare(right.name)
  if (nameDiff !== 0) return nameDiff
  return left.serverId.localeCompare(right.serverId)
}

function safeTokenize(text: string | undefined): string[] {
  return typeof text === 'string' ? tokenize(text) : []
}

function buildToolLexicalTokens(toolcard: Toolcard): string[] {
  return [
    ...safeTokenize(toolcard.name),
    ...safeTokenize(toolcard.description),
    ...toolcard.tags.flatMap((tag) => safeTokenize(tag)),
    ...safeTokenize(toolcard.serverId),
  ]
}

function uniqueTokens(values: string[]): string[] {
  return [...new Set(values)]
}

function overlapCoefficient(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  let overlap = 0
  for (const token of leftSet) {
    if (rightSet.has(token)) overlap += 1
  }
  return overlap / Math.min(leftSet.size, rightSet.size)
}

export function buildSessionIntent(
  namespace: string,
  starterPackHints: string[],
  recentOutcomes: ExecutionOutcome[],
  initialIntentText?: string,
  focus?: FocusConfig,
): SessionIntent {
  const successfulOutcomes = recentOutcomes
    .filter((outcome) => outcome.outcome === OutcomeClass.Success)
    .slice(-(focus?.lookback ?? 5))

  const recentToolNames = successfulOutcomes.map((outcome) => outcome.toolName)
  const dominantCapability = resolveFocusFromOutcomes(recentOutcomes, focus).dominantCapability
  const initialIntentTerms = uniqueTokens(safeTokenize(initialIntentText))
  const queryTerms = uniqueTokens([
    ...initialIntentTerms,
    ...starterPackHints.flatMap((hint) => tokenize(hint)),
    ...recentToolNames.flatMap((toolName) => safeTokenize(toolName)),
    ...successfulOutcomes.flatMap((outcome) => safeTokenize(outcome.serverId)),
    ...safeTokenize(namespace),
    ...(dominantCapability ? CAPABILITY_TERMS[dominantCapability] : []),
  ])

  return {
    query: queryTerms.join(' '),
    queryTerms,
    hintTerms: uniqueTokens(starterPackHints.flatMap((hint) => tokenize(hint))),
    initialIntentTerms,
    successfulToolKeys: new Set(
      successfulOutcomes.map((outcome) => toolCandidateKey(outcome.serverId, outcome.toolName)),
    ),
    successfulServerIds: new Set(successfulOutcomes.map((outcome) => outcome.serverId)),
    recentToolNames,
    dominantCapability,
  }
}

function buildContextSignals(
  toolcard: Toolcard,
  intent: SessionIntent,
  currentNamespace: string,
): ContextSignals {
  const toolTokens = uniqueTokens(buildToolLexicalTokens(toolcard))
  const exactRecentReuse = intent.successfulToolKeys.has(toolCandidateKey(toolcard.serverId, toolcard.name)) ? 1 : 0
  const recentServerAffinity = intent.successfulServerIds.has(toolcard.serverId) ? 1 : 0
  const starterPackAffinity = overlapCoefficient(toolTokens, intent.hintTerms)
  const initialIntentAffinity = overlapCoefficient(toolTokens, intent.initialIntentTerms)
  const namespaceAffinity = toolcard.namespaceHints?.includes(currentNamespace) ? 1 : 0
  const dominantCapabilityAffinity =
    intent.dominantCapability && inferCapabilityFromTool(toolcard) === intent.dominantCapability ? 1 : 0

  const firstToken = safeTokenize(toolcard.name)[0]
  const siblingAffinity =
    exactRecentReuse === 0 && firstToken && intent.recentToolNames.some((recentName) => {
      const recentFirst = safeTokenize(recentName)[0]
      return recentFirst === firstToken && recentName !== toolcard.name
    })
      ? 1
      : 0

  return {
    exactRecentReuse,
    recentServerAffinity,
    starterPackAffinity,
    initialIntentAffinity,
    namespaceAffinity,
    dominantCapabilityAffinity,
    siblingAffinity,
  }
}

function compareContextSignals(
  left: ContextSignals,
  right: ContextSignals,
): number {
  if (right.exactRecentReuse !== left.exactRecentReuse) {
    return right.exactRecentReuse - left.exactRecentReuse
  }
  if (right.recentServerAffinity !== left.recentServerAffinity) {
    return right.recentServerAffinity - left.recentServerAffinity
  }
  if (right.initialIntentAffinity !== left.initialIntentAffinity) {
    return right.initialIntentAffinity - left.initialIntentAffinity
  }
  if (right.dominantCapabilityAffinity !== left.dominantCapabilityAffinity) {
    return right.dominantCapabilityAffinity - left.dominantCapabilityAffinity
  }
  if (right.starterPackAffinity !== left.starterPackAffinity) {
    return right.starterPackAffinity - left.starterPackAffinity
  }
  if (right.namespaceAffinity !== left.namespaceAffinity) {
    return right.namespaceAffinity - left.namespaceAffinity
  }
  if (right.siblingAffinity !== left.siblingAffinity) {
    return right.siblingAffinity - left.siblingAffinity
  }
  return 0
}

function weightedRrf(rank: number, weight: number): number {
  return weight / (RRF_K + rank)
}

function buildFieldRankMap(
  tools: Toolcard[],
  query: string,
  getText: (tool: Toolcard) => string,
): FieldRankMap | undefined {
  const ranked = rankByBm25(tools, query, getText, toolTieBreaker)
  if (ranked.every((entry) => entry.score === 0)) {
    return undefined
  }
  return {
    ranks: new Map(
      ranked.map((entry, index) => [toolCandidateKey(entry.item.serverId, entry.item.name), index + 1]),
    ),
    matchedTerms: new Map(
      ranked.map((entry) => [toolCandidateKey(entry.item.serverId, entry.item.name), entry.matchedTerms]),
    ),
  }
}

export function rankToolsHybrid(
  tools: Toolcard[],
  signals: {
    namespace: string
    starterPackHints: string[]
    recentOutcomes: ExecutionOutcome[]
    initialIntentText?: string
    focus?: FocusConfig
    lexicalEnabled?: boolean
  },
): RankedTool[] {
  if (tools.length === 0) return []

  const intent = buildSessionIntent(
    signals.namespace,
    signals.starterPackHints,
    signals.recentOutcomes,
    signals.initialIntentText,
    signals.focus,
  )
  const keyFor = (toolcard: Toolcard) => toolCandidateKey(toolcard.serverId, toolcard.name)
  const breakdownByKey = new Map<string, Record<string, number>>()
  const matchedTermsByKey = new Map<string, Set<string>>()

  const contextEntries = [...tools]
    .map((toolcard) => ({
      toolcard,
      context: buildContextSignals(toolcard, intent, signals.namespace),
    }))
    .sort((left, right) => {
      const diff = compareContextSignals(left.context, right.context)
      if (diff !== 0) return diff
      return toolTieBreaker(left.toolcard, right.toolcard)
    })
  const contextByKey = new Map(
    contextEntries.map((entry) => [keyFor(entry.toolcard), entry.context]),
  )
  const hasContextSignal = contextEntries.some(({ context }) =>
    Object.values(context).some((value) => value > 0),
  )

  const contextRanks = hasContextSignal
    ? new Map(contextEntries.map((entry, index) => [keyFor(entry.toolcard), index + 1]))
    : undefined

  const lexicalEnabled = signals.lexicalEnabled !== false
  const fieldRankers = lexicalEnabled && intent.queryTerms.length > 0
    ? {
        name: buildFieldRankMap(tools, intent.query, (tool) => tool.name),
        tags: buildFieldRankMap(tools, intent.query, (tool) => tool.tags.join(' ')),
        description: buildFieldRankMap(tools, intent.query, (tool) => tool.description ?? ''),
        serverId: buildFieldRankMap(tools, intent.query, (tool) => tool.serverId),
      }
    : undefined
  const hasBm25Signal = Object.values(fieldRankers ?? {}).some((ranker) => ranker !== undefined)

  const rawEntries = tools.map((toolcard) => {
    const key = keyFor(toolcard)
    const breakdown: Record<string, number> = {}
    let rawRrf = 0

    const context = contextByKey.get(key) ?? buildContextSignals(toolcard, intent, signals.namespace)
    breakdown['retrieval.context.exactRecentReuse'] = context.exactRecentReuse
    breakdown['retrieval.context.recentServerAffinity'] = context.recentServerAffinity
    breakdown['retrieval.context.initialIntentAffinity'] = context.initialIntentAffinity
    breakdown['retrieval.context.starterPackAffinity'] = context.starterPackAffinity
    breakdown['retrieval.context.namespaceAffinity'] = context.namespaceAffinity
    breakdown['retrieval.context.dominantCapabilityAffinity'] = context.dominantCapabilityAffinity
    breakdown['retrieval.context.siblingAffinity'] = context.siblingAffinity
    if (contextRanks) {
      const contextRank = contextRanks.get(key) ?? tools.length
      const contextContribution = weightedRrf(contextRank, FIELD_WEIGHTS.context)
      rawRrf += contextContribution
      breakdown['retrieval.context.rank'] = contextRank
      breakdown['retrieval.context.rrf'] = contextContribution
    }

    if (fieldRankers) {
      for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
        if (field === 'context') continue
        const fieldRanker = fieldRankers[field as keyof typeof fieldRankers]
        if (!fieldRanker) continue
        const rank = fieldRanker.ranks.get(key)
        if (rank === undefined) continue
        const contribution = weightedRrf(rank, weight)
        rawRrf += contribution
        breakdown[`retrieval.bm25.${field}.rank`] = rank
        breakdown[`retrieval.bm25.${field}.rrf`] = contribution
        const matchedTerms = fieldRanker.matchedTerms.get(key) ?? []
        if (matchedTerms.length > 0) {
          const seen = matchedTermsByKey.get(key) ?? new Set<string>()
          for (const term of matchedTerms) seen.add(term)
          matchedTermsByKey.set(key, seen)
        }
      }
    }

    breakdown['retrieval.rrf'] = rawRrf
    breakdownByKey.set(key, breakdown)
    return { toolcard, rawRrf }
  })

  const rankedByRrf = rawEntries.sort((left, right) => {
    const diff = right.rawRrf - left.rawRrf
    if (diff !== 0) return diff
    return toolTieBreaker(left.toolcard, right.toolcard)
  })

  return rankedByRrf.map((entry, index) => {
    const key = keyFor(entry.toolcard)
    const breakdown = breakdownByKey.get(key) ?? {}
    const retrievalRankScore = hasContextSignal || hasBm25Signal ? tools.length - index : 0
    if (retrievalRankScore > 0) {
      breakdown['retrieval.rank'] = index + 1
      breakdown['retrieval.rankScore'] = retrievalRankScore
    }
    return {
      toolcard: entry.toolcard,
      score: retrievalRankScore,
      breakdown,
      matchedTerms: [...(matchedTermsByKey.get(key) ?? new Set<string>())].sort(),
    }
  })
}
