import type {
  AggregateMetrics,
  BenchmarkReport,
  E2EAggregateMetrics,
  E2ETaskResult,
  RetrievalCaseResult,
} from '../types.js'

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

export function summarizeRetrieval(results: RetrievalCaseResult[], target: 'gateway' | 'codeMode' | 'baseline'): AggregateMetrics {
  return {
    scenarioCount: results.length,
    top1Accuracy: round(mean(results.map((result) => (result[target].rank === 1 ? 1 : 0)))),
    recallAt3: round(mean(results.map((result) => (result[target].hitAt3 ? 1 : 0)))),
    recallAt5: round(mean(results.map((result) => (result[target].hitAt5 ? 1 : 0)))),
    meanReciprocalRank: round(mean(results.map((result) => result[target].reciprocalRank))),
    averageVisibleToolCount: round(mean(results.map((result) => result[target].visibleToolCount))),
    averageTotalTokens: round(mean(results.map((result) => result[target].totalTokens))),
  }
}

export function summarizeE2E(results: E2ETaskResult[], target: 'gateway' | 'codeMode' | 'baseline'): E2EAggregateMetrics {
  const base: E2EAggregateMetrics = {
    scenarioCount: results.length,
    successRate: round(mean(results.map((result) => (result[target].success ? 1 : 0)))),
    averageVisibleToolCount: round(mean(results.map((result) => result[target].visibleToolCount))),
    averageTotalContextTokens: round(mean(results.map((result) => result[target].totalContextTokens))),
    averageLatencyMs: round(mean(results.map((result) => result[target].latencyMs))),
    averageToolCalls: round(mean(results.map((result) => result[target].toolCalls))),
  }

  if (target === 'gateway') {
    return {
      ...base,
      averageSearchCalls: round(mean(results.map((result) => result.gateway.searchCalls))),
      averageListCatalogTokens: round(mean(results.map((result) => result.gateway.listCatalogTokens))),
      averageSearchResponseTokens: round(mean(results.map((result) => result.gateway.searchResponseTokens))),
      averageProxyCallRequestTokens: round(mean(results.map((result) => result.gateway.proxyCallRequestTokens))),
      averageProxyCallResponseTokens: round(mean(results.map((result) => result.gateway.proxyCallResponseTokens))),
    }
  }

  if (target === 'codeMode') {
    return {
      ...base,
      averageListCatalogTokens: round(mean(results.map((result) => result.codeMode.listCatalogTokens))),
      averageProxyCallRequestTokens: round(mean(results.map((result) => result.codeMode.runCodeRequestTokens))),
      averageProxyCallResponseTokens: round(mean(results.map((result) => result.codeMode.runCodeResponseTokens))),
    }
  }

  return {
    ...base,
    averageCatalogTokens: round(mean(results.map((result) => result.baseline.catalogTokens))),
    averageDirectCallRequestTokens: round(mean(results.map((result) => result.baseline.directCallRequestTokens))),
    averageDirectCallResponseTokens: round(mean(results.map((result) => result.baseline.directCallResponseTokens))),
  }
}

export function renderMarkdownReport(report: BenchmarkReport): string {
  const lines: string[] = []
  lines.push(`# Benchmark Report`)
  lines.push(``)
  lines.push(`- Dataset: \`${report.dataset.name}\``)
  lines.push(`- Scenarios: ${report.dataset.scenarioCount}`)
  lines.push(`- Generated at: ${report.generatedAt}`)
  if (report.dataset.description) {
    lines.push(`- Description: ${report.dataset.description}`)
  }
  lines.push(``)
  lines.push(`## Retrieval`)
  lines.push(``)
  lines.push(`| Target | Top1 | Recall@3 | Recall@5 | MRR | Avg tools | Avg tokens |`)
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`)
  lines.push(`| Compat gateway | ${report.retrieval.gateway.top1Accuracy} | ${report.retrieval.gateway.recallAt3} | ${report.retrieval.gateway.recallAt5} | ${report.retrieval.gateway.meanReciprocalRank} | ${report.retrieval.gateway.averageVisibleToolCount} | ${report.retrieval.gateway.averageTotalTokens} |`)
  lines.push(`| Code-mode gateway | ${report.retrieval.codeMode.top1Accuracy} | ${report.retrieval.codeMode.recallAt3} | ${report.retrieval.codeMode.recallAt5} | ${report.retrieval.codeMode.meanReciprocalRank} | ${report.retrieval.codeMode.averageVisibleToolCount} | ${report.retrieval.codeMode.averageTotalTokens} |`)
  lines.push(`| Baseline | ${report.retrieval.baseline.top1Accuracy} | ${report.retrieval.baseline.recallAt3} | ${report.retrieval.baseline.recallAt5} | ${report.retrieval.baseline.meanReciprocalRank} | ${report.retrieval.baseline.averageVisibleToolCount} | ${report.retrieval.baseline.averageTotalTokens} |`)
  lines.push(``)
  lines.push(`_Compat retrieval tokens = tools/list + gateway_search_tools response. Code-mode = virtual code-mode catalog + gateway_run_code request/response. Baseline = full filtered catalog (policy/starter pack)._`)
  lines.push(``)
  lines.push(`## E2E`)
  lines.push(``)
  lines.push(`| Target | Success | Avg tools | Avg context tokens | Avg latency ms | Avg tool calls | Avg search calls |`)
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`)
  lines.push(`| Compat gateway | ${report.e2e.gateway.successRate} | ${report.e2e.gateway.averageVisibleToolCount} | ${report.e2e.gateway.averageTotalContextTokens} | ${report.e2e.gateway.averageLatencyMs} | ${report.e2e.gateway.averageToolCalls} | ${report.e2e.gateway.averageSearchCalls ?? 0} |`)
  lines.push(`| Code-mode gateway | ${report.e2e.codeMode.successRate} | ${report.e2e.codeMode.averageVisibleToolCount} | ${report.e2e.codeMode.averageTotalContextTokens} | ${report.e2e.codeMode.averageLatencyMs} | ${report.e2e.codeMode.averageToolCalls} | 0 |`)
  lines.push(`| Baseline | ${report.e2e.baseline.successRate} | ${report.e2e.baseline.averageVisibleToolCount} | ${report.e2e.baseline.averageTotalContextTokens} | ${report.e2e.baseline.averageLatencyMs} | ${report.e2e.baseline.averageToolCalls} | — |`)
  lines.push(``)
  lines.push(`_Compat context = list + search result + gateway_call_tool request/response. Code-mode = code-mode catalog + gateway_run_code request/response. Baseline = catalog + direct tools/call request/response._`)
  lines.push(``)
  lines.push(`## Cases`)
  lines.push(``)
  for (const result of report.e2e.cases) {
    lines.push(`- \`${result.scenarioId}\`: compat=${result.gateway.success ? 'ok' : 'fail'} (${result.gateway.chosenTool ?? 'none'}), code-mode=${result.codeMode.success ? 'ok' : 'fail'} (${result.codeMode.chosenTool ?? 'none'}), baseline=${result.baseline.success ? 'ok' : 'fail'} (${result.baseline.chosenTool ?? 'none'})`)
  }
  lines.push(``)
  return lines.join('\n')
}
