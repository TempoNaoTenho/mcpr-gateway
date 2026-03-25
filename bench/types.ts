import { z } from 'zod'
import { Mode } from '../src/types/enums.js'

const searchLimitSchema = z.number().int().min(1).max(50).optional()

export const BenchmarkScenarioSchema = z.object({
  id: z.string().min(1),
  namespace: z.string().min(1),
  prompt: z.string().min(1),
  expectedTools: z.array(z.string().min(1)).min(1),
  expectedServerIds: z.array(z.string().min(1)).optional(),
  discoveryQuery: z.string().min(1).optional(),
  searchLimit: searchLimitSchema,
  mode: z.nativeEnum(Mode).default(Mode.Read),
  toolArgs: z.record(z.unknown()).optional(),
  authHeader: z.string().min(1).optional(),
  sessionSteps: z.array(
    z.object({
      prompt: z.string().min(1),
      expectedTools: z.array(z.string().min(1)).min(1),
      expectedServerIds: z.array(z.string().min(1)).optional(),
      discoveryQuery: z.string().min(1).optional(),
      searchLimit: searchLimitSchema,
      toolArgs: z.record(z.unknown()).optional(),
    }),
  ).min(2).optional(),
})

export type BenchmarkScenario = z.infer<typeof BenchmarkScenarioSchema>
export type BenchmarkScenarioStep = NonNullable<BenchmarkScenario['sessionSteps']>[number]

export type RetrievalStepResult = {
  prompt: string
  expectedTools: string[]
  gateway: {
    visibleToolCount: number
    /** listCatalogTokens + searchResponseTokens */
    totalTokens: number
    listCatalogTokens: number
    searchResponseTokens: number
    matchedTool?: string
    matchedServerId?: string
    rank: number | null
    reciprocalRank: number
    hitAt3: boolean
    hitAt5: boolean
    searchUsed: boolean
    searchMatchCount: number
  }
  codeMode: {
    visibleToolCount: number
    totalTokens: number
    listCatalogTokens: number
    runCodeRequestTokens: number
    runCodeResponseTokens: number
    matchedTool?: string
    matchedServerId?: string
    rank: number | null
    reciprocalRank: number
    hitAt3: boolean
    hitAt5: boolean
  }
  baseline: {
    visibleToolCount: number
    totalTokens: number
    matchedTool?: string
    matchedServerId?: string
    rank: number | null
    reciprocalRank: number
    hitAt3: boolean
    hitAt5: boolean
  }
}

export type E2EStepResult = {
  prompt: string
  expectedTools: string[]
  gateway: {
    success: boolean
    chosenTool?: string
    chosenServerId?: string
    searchUsed: boolean
    searchCalls: number
    toolCalls: number
    visibleToolCount: number
    listCatalogTokens: number
    searchResponseTokens: number
    proxyCallRequestTokens: number
    proxyCallResponseTokens: number
    totalContextTokens: number
    latencyMs: number
    error?: string
  }
  codeMode: {
    success: boolean
    chosenTool?: string
    chosenServerId?: string
    toolCalls: number
    visibleToolCount: number
    listCatalogTokens: number
    runCodeRequestTokens: number
    runCodeResponseTokens: number
    totalContextTokens: number
    latencyMs: number
    error?: string
  }
  baseline: {
    success: boolean
    chosenTool?: string
    chosenServerId?: string
    toolCalls: number
    visibleToolCount: number
    catalogTokens: number
    directCallRequestTokens: number
    directCallResponseTokens: number
    totalContextTokens: number
    latencyMs: number
    error?: string
  }
}

export const BenchmarkDatasetSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  scenarios: z.array(BenchmarkScenarioSchema).min(1),
})

export type BenchmarkDataset = z.infer<typeof BenchmarkDatasetSchema>

export type ToolExposure = {
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
  totalTokens: number
}

export type RetrievalCaseResult = {
  scenarioId: string
  namespace: string
  prompt: string
  expectedTools: string[]
  gateway: {
    visibleToolCount: number
    totalTokens: number
    listCatalogTokens: number
    searchResponseTokens: number
    matchedTool?: string
    matchedServerId?: string
    rank: number | null
    reciprocalRank: number
    hitAt3: boolean
    hitAt5: boolean
    searchUsed: boolean
    searchMatchCount: number
  }
  codeMode: {
    visibleToolCount: number
    totalTokens: number
    listCatalogTokens: number
    runCodeRequestTokens: number
    runCodeResponseTokens: number
    matchedTool?: string
    matchedServerId?: string
    rank: number | null
    reciprocalRank: number
    hitAt3: boolean
    hitAt5: boolean
  }
  baseline: {
    visibleToolCount: number
    totalTokens: number
    matchedTool?: string
    matchedServerId?: string
    rank: number | null
    reciprocalRank: number
    hitAt3: boolean
    hitAt5: boolean
  }
  steps?: RetrievalStepResult[]
}

export type E2ETaskResult = {
  scenarioId: string
  namespace: string
  prompt: string
  gateway: {
    success: boolean
    chosenTool?: string
    chosenServerId?: string
    searchUsed: boolean
    searchCalls: number
    toolCalls: number
    visibleToolCount: number
    listCatalogTokens: number
    searchResponseTokens: number
    proxyCallRequestTokens: number
    proxyCallResponseTokens: number
    totalContextTokens: number
    latencyMs: number
    error?: string
  }
  codeMode: {
    success: boolean
    chosenTool?: string
    chosenServerId?: string
    toolCalls: number
    visibleToolCount: number
    listCatalogTokens: number
    runCodeRequestTokens: number
    runCodeResponseTokens: number
    totalContextTokens: number
    latencyMs: number
    error?: string
  }
  baseline: {
    success: boolean
    chosenTool?: string
    chosenServerId?: string
    toolCalls: number
    visibleToolCount: number
    catalogTokens: number
    directCallRequestTokens: number
    directCallResponseTokens: number
    totalContextTokens: number
    latencyMs: number
    error?: string
  }
  steps?: E2EStepResult[]
}

export type AggregateMetrics = {
  scenarioCount: number
  top1Accuracy: number
  recallAt3: number
  recallAt5: number
  meanReciprocalRank: number
  averageVisibleToolCount: number
  averageTotalTokens: number
}

export type E2EAggregateMetrics = {
  scenarioCount: number
  successRate: number
  averageVisibleToolCount: number
  averageTotalContextTokens: number
  averageLatencyMs: number
  averageToolCalls: number
  averageSearchCalls?: number
  averageListCatalogTokens?: number
  averageSearchResponseTokens?: number
  averageProxyCallRequestTokens?: number
  averageProxyCallResponseTokens?: number
  averageCatalogTokens?: number
  averageDirectCallRequestTokens?: number
  averageDirectCallResponseTokens?: number
}

export type BenchmarkReport = {
  dataset: {
    name: string
    description?: string
    scenarioCount: number
  }
  generatedAt: string
  retrieval: {
    gateway: AggregateMetrics
    codeMode: AggregateMetrics
    baseline: AggregateMetrics
    cases: RetrievalCaseResult[]
  }
  e2e: {
    gateway: E2EAggregateMetrics
    codeMode: E2EAggregateMetrics
    baseline: E2EAggregateMetrics
    cases: E2ETaskResult[]
  }
}
