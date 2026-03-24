import { OutcomeClass } from '../types/enums.js'
import type { ExecutionOutcome } from '../types/execution.js'
import type { Toolcard, VisibleTool } from '../types/tools.js'

export const TOOL_CAPABILITIES = [
  'files',
  'git',
  'browser',
  'docs',
  'communication',
  'ticketing',
  'observability',
  'database',
  'search',
  'misc',
] as const

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number]

const CAPABILITY_PATTERNS: Array<{ capability: ToolCapability; pattern: RegExp }> = [
  { capability: 'files', pattern: /\b(file|files|fs|path|paths|dir|dirs|directory|folder|folders|read_file|write_file|edit_file|list_dir)\b/i },
  { capability: 'git', pattern: /\b(git|branch|commit|diff|repo|pull_request|pr|checkout|stash)\b/i },
  { capability: 'browser', pattern: /\b(browser|playwright|page|pages|tab|tabs|click|navigate|navigation|screenshot|scrape|crawl|extract|dom|web|website|html|url)\b/i },
  { capability: 'docs', pattern: /\b(doc|docs|documentation|api|apis|sdk|manual|reference|references|notion|confluence|wiki|kb|knowledge|readme|guide|guides)\b/i },
  { capability: 'communication', pattern: /\b(slack|email|mail|gmail|message|messages|discord|teams|chat|calendar)\b/i },
  { capability: 'ticketing', pattern: /\b(jira|linear|ticket|tickets|issue|issues|incident|bug|task)\b/i },
  { capability: 'observability', pattern: /\b(sentry|log|logs|trace|traces|metric|metrics|alert|alerts|monitor|monitoring|datadog)\b/i },
  { capability: 'database', pattern: /\b(sql|postgres|postgresql|mysql|sqlite|mongo|database|databases|db|schema|schemas|query|queries|table|tables|record|records|row|rows|column|columns)\b/i },
  { capability: 'search', pattern: /\b(search|find|lookup|query|queries|index|retrieve|retrieval|discover|discovery|browse)\b/i },
]

type CapabilitySource = {
  name: string
  description?: string
  tags?: string[]
  serverId?: string
  namespace?: string
}

export type FocusConfig = {
  enabled?: boolean
  lookback?: number
  minDominantSuccesses?: number
}

export type FocusResolution = {
  dominantCapability?: ToolCapability
  recentCapabilities: ToolCapability[]
  totalSignals: number
}

export function inferToolCapability(source: CapabilitySource): ToolCapability {
  const haystack = [
    source.name,
    source.description ?? '',
    source.serverId ?? '',
    source.namespace ?? '',
    ...(source.tags ?? []),
  ]
    .join(' ')
    .toLowerCase()

  for (const entry of CAPABILITY_PATTERNS) {
    if (entry.pattern.test(haystack)) {
      return entry.capability
    }
  }

  return 'misc'
}

export function resolveFocusFromOutcomes(
  recentOutcomes: ExecutionOutcome[],
  config: FocusConfig = {},
): FocusResolution {
  if (config.enabled === false) {
    return { recentCapabilities: [], totalSignals: 0 }
  }

  const lookback = config.lookback ?? 5
  const minDominantSuccesses = config.minDominantSuccesses ?? 2
  const successes = recentOutcomes
    .filter((outcome) => outcome.outcome === OutcomeClass.Success)
    .slice(-lookback)

  const recentCapabilities = successes.map((outcome) =>
    inferToolCapability({ name: outcome.toolName, serverId: outcome.serverId }),
  )

  if (recentCapabilities.length === 0) {
    return { recentCapabilities, totalSignals: 0 }
  }

  const counts = new Map<ToolCapability, number>()
  for (const capability of recentCapabilities) {
    counts.set(capability, (counts.get(capability) ?? 0) + 1)
  }

  const dominant = [...counts.entries()]
    .sort((left, right) => {
      const diff = right[1] - left[1]
      if (diff !== 0) return diff
      return left[0].localeCompare(right[0])
    })[0]

  const dominantCapability =
    dominant && dominant[1] >= minDominantSuccesses ? dominant[0] : undefined

  return {
    dominantCapability,
    recentCapabilities,
    totalSignals: recentCapabilities.length,
  }
}

export function inferCapabilityFromTool(tool: Toolcard | VisibleTool): ToolCapability {
  return inferToolCapability({
    name: tool.name,
    description: tool.description,
    tags: 'tags' in tool ? tool.tags : [],
    serverId: tool.serverId,
    namespace: 'namespace' in tool ? tool.namespace : undefined,
  })
}
