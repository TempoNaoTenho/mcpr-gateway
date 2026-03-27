import { describe, expect, it } from 'vitest'
import { renderMarkdownReport, summarizeE2E, summarizeReportNamespace, summarizeRetrieval } from '../../bench/lib/metrics.js'

describe('benchmark metrics', () => {
  it('summarizes retrieval cases', () => {
    const summary = summarizeRetrieval([
      {
        scenarioId: 'a',
        namespace: 'x',
        prompt: 'one',
        expectedTools: ['tool_a'],
        gateway: {
          visibleToolCount: 2,
          totalTokens: 10,
          listCatalogTokens: 2,
          searchResponseTokens: 8,
          rank: 1,
          reciprocalRank: 1,
          hitAt3: true,
          hitAt5: true,
          searchUsed: true,
          searchMatchCount: 4,
          matchedTool: 'tool_a',
        },
        codeMode: {
          visibleToolCount: 2,
          totalTokens: 6,
          listCatalogTokens: 2,
          runCodeRequestTokens: 2,
          runCodeResponseTokens: 2,
          rank: 1,
          reciprocalRank: 1,
          hitAt3: true,
          hitAt5: true,
          matchedTool: 'tool_a',
        },
        baseline: { visibleToolCount: 8, totalTokens: 40, rank: 2, reciprocalRank: 0.5, hitAt3: true, hitAt5: true, matchedTool: 'tool_a' },
      },
      {
        scenarioId: 'b',
        namespace: 'x',
        prompt: 'two',
        expectedTools: ['tool_b'],
        gateway: {
          visibleToolCount: 2,
          totalTokens: 12,
          listCatalogTokens: 2,
          searchResponseTokens: 10,
          rank: null,
          reciprocalRank: 0,
          hitAt3: false,
          hitAt5: false,
          searchUsed: true,
          searchMatchCount: 2,
        },
        codeMode: {
          visibleToolCount: 2,
          totalTokens: 8,
          listCatalogTokens: 2,
          runCodeRequestTokens: 3,
          runCodeResponseTokens: 3,
          rank: null,
          reciprocalRank: 0,
          hitAt3: false,
          hitAt5: false,
        },
        baseline: { visibleToolCount: 8, totalTokens: 40, rank: 1, reciprocalRank: 1, hitAt3: true, hitAt5: true, matchedTool: 'tool_b' },
      },
    ], 'gateway')

    expect(summary.top1Accuracy).toBe(0.5)
    expect(summary.recallAt3).toBe(0.5)
    expect(summary.meanReciprocalRank).toBe(0.5)
  })

  it('summarizes e2e cases and renders markdown', () => {
    const summary = summarizeE2E([
      {
        scenarioId: 'a',
        namespace: 'x',
        prompt: 'one',
        gateway: {
          success: true,
          searchUsed: true,
          searchCalls: 1,
          toolCalls: 2,
          visibleToolCount: 2,
          listCatalogTokens: 2,
          searchResponseTokens: 5,
          proxyCallRequestTokens: 2,
          proxyCallResponseTokens: 3,
          totalContextTokens: 12,
          latencyMs: 25,
        },
        codeMode: {
          success: true,
          toolCalls: 1,
          visibleToolCount: 2,
          listCatalogTokens: 2,
          runCodeRequestTokens: 3,
          runCodeResponseTokens: 2,
          totalContextTokens: 7,
          latencyMs: 12,
        },
        baseline: {
          success: true,
          toolCalls: 1,
          visibleToolCount: 8,
          catalogTokens: 40,
          directCallRequestTokens: 2,
          directCallResponseTokens: 2,
          totalContextTokens: 44,
          latencyMs: 15,
        },
      },
      {
        scenarioId: 'b',
        namespace: 'x',
        prompt: 'two',
        gateway: {
          success: false,
          searchUsed: true,
          searchCalls: 1,
          toolCalls: 2,
          visibleToolCount: 2,
          listCatalogTokens: 2,
          searchResponseTokens: 6,
          proxyCallRequestTokens: 2,
          proxyCallResponseTokens: 10,
          totalContextTokens: 20,
          latencyMs: 35,
          error: 'miss',
        },
        codeMode: {
          success: false,
          toolCalls: 1,
          visibleToolCount: 2,
          listCatalogTokens: 2,
          runCodeRequestTokens: 3,
          runCodeResponseTokens: 4,
          totalContextTokens: 9,
          latencyMs: 18,
          error: 'miss',
        },
        baseline: {
          success: true,
          toolCalls: 1,
          visibleToolCount: 8,
          catalogTokens: 40,
          directCallRequestTokens: 2,
          directCallResponseTokens: 2,
          totalContextTokens: 44,
          latencyMs: 18,
        },
      },
    ], 'gateway')

    expect(summary.successRate).toBe(0.5)
    expect(summary.averageSearchCalls).toBe(1)
    expect(summary.averageTotalContextTokens).toBe(16)

    const markdown = renderMarkdownReport({
      dataset: { name: 'demo', scenarioCount: 1 },
      generatedAt: '2026-03-22T00:00:00.000Z',
      retrieval: {
        gateway: { scenarioCount: 1, top1Accuracy: 1, recallAt3: 1, recallAt5: 1, meanReciprocalRank: 1, averageVisibleToolCount: 3, averageTotalTokens: 10 },
        codeMode: { scenarioCount: 1, top1Accuracy: 1, recallAt3: 1, recallAt5: 1, meanReciprocalRank: 1, averageVisibleToolCount: 2, averageTotalTokens: 7 },
        baseline: { scenarioCount: 1, top1Accuracy: 1, recallAt3: 1, recallAt5: 1, meanReciprocalRank: 1, averageVisibleToolCount: 8, averageTotalTokens: 40 },
        cases: [],
      },
      e2e: {
        gateway: {
          scenarioCount: 1,
          successRate: 1,
          averageVisibleToolCount: 3,
          averageTotalContextTokens: 10,
          averageLatencyMs: 20,
          averageToolCalls: 1,
          averageSearchCalls: 1,
        },
        codeMode: {
          scenarioCount: 1,
          successRate: 1,
          averageVisibleToolCount: 2,
          averageTotalContextTokens: 7,
          averageLatencyMs: 12,
          averageToolCalls: 1,
        },
        baseline: {
          scenarioCount: 1,
          successRate: 1,
          averageVisibleToolCount: 8,
          averageTotalContextTokens: 40,
          averageLatencyMs: 15,
          averageToolCalls: 1,
        },
        cases: [],
      },
    })

    expect(markdown).toContain('# Benchmark Report')
    expect(markdown).toContain('| Compat gateway |')
    expect(markdown).toContain('| Code-mode gateway |')
    expect(markdown).toContain('Avg context tokens')
  })

  it('summarizes report metrics per namespace instead of using global aggregates', () => {
    const report = {
      dataset: { name: 'demo', scenarioCount: 2 },
      generatedAt: '2026-03-22T00:00:00.000Z',
      retrieval: {
        gateway: { scenarioCount: 2, top1Accuracy: 0.5, recallAt3: 0.5, recallAt5: 0.5, meanReciprocalRank: 0.5, averageVisibleToolCount: 2, averageTotalTokens: 11 },
        codeMode: { scenarioCount: 2, top1Accuracy: 1, recallAt3: 1, recallAt5: 1, meanReciprocalRank: 1, averageVisibleToolCount: 2, averageTotalTokens: 7 },
        baseline: { scenarioCount: 2, top1Accuracy: 1, recallAt3: 1, recallAt5: 1, meanReciprocalRank: 1, averageVisibleToolCount: 8, averageTotalTokens: 40 },
        cases: [
          {
            scenarioId: 'compat-1',
            namespace: 'compat',
            prompt: 'one',
            expectedTools: ['tool_a'],
            gateway: {
              visibleToolCount: 2,
              totalTokens: 10,
              listCatalogTokens: 2,
              searchResponseTokens: 8,
              rank: null,
              reciprocalRank: 0,
              hitAt3: false,
              hitAt5: false,
              searchUsed: true,
              searchMatchCount: 1,
            },
            codeMode: {
              visibleToolCount: 2,
              totalTokens: 6,
              listCatalogTokens: 2,
              runCodeRequestTokens: 2,
              runCodeResponseTokens: 2,
              rank: 1,
              reciprocalRank: 1,
              hitAt3: true,
              hitAt5: true,
              matchedTool: 'tool_a',
            },
            baseline: { visibleToolCount: 8, totalTokens: 40, rank: 1, reciprocalRank: 1, hitAt3: true, hitAt5: true, matchedTool: 'tool_a' },
          },
          {
            scenarioId: 'default-1',
            namespace: 'default',
            prompt: 'two',
            expectedTools: ['tool_b'],
            gateway: {
              visibleToolCount: 2,
              totalTokens: 12,
              listCatalogTokens: 2,
              searchResponseTokens: 10,
              rank: 1,
              reciprocalRank: 1,
              hitAt3: true,
              hitAt5: true,
              searchUsed: true,
              searchMatchCount: 2,
              matchedTool: 'tool_b',
            },
            codeMode: {
              visibleToolCount: 2,
              totalTokens: 8,
              listCatalogTokens: 2,
              runCodeRequestTokens: 3,
              runCodeResponseTokens: 3,
              rank: 1,
              reciprocalRank: 1,
              hitAt3: true,
              hitAt5: true,
              matchedTool: 'tool_b',
            },
            baseline: { visibleToolCount: 8, totalTokens: 40, rank: 1, reciprocalRank: 1, hitAt3: true, hitAt5: true, matchedTool: 'tool_b' },
          },
        ],
      },
      e2e: {
        gateway: {
          scenarioCount: 2,
          successRate: 0.5,
          averageVisibleToolCount: 2,
          averageTotalContextTokens: 16,
          averageLatencyMs: 30,
          averageToolCalls: 2,
          averageSearchCalls: 1,
        },
        codeMode: {
          scenarioCount: 2,
          successRate: 1,
          averageVisibleToolCount: 2,
          averageTotalContextTokens: 8,
          averageLatencyMs: 15,
          averageToolCalls: 1,
        },
        baseline: {
          scenarioCount: 2,
          successRate: 1,
          averageVisibleToolCount: 8,
          averageTotalContextTokens: 44,
          averageLatencyMs: 16,
          averageToolCalls: 1,
        },
        cases: [
          {
            scenarioId: 'compat-1',
            namespace: 'compat',
            prompt: 'one',
            gateway: {
              success: false,
              searchUsed: true,
              searchCalls: 1,
              toolCalls: 2,
              visibleToolCount: 2,
              listCatalogTokens: 2,
              searchResponseTokens: 5,
              proxyCallRequestTokens: 2,
              proxyCallResponseTokens: 3,
              totalContextTokens: 12,
              latencyMs: 25,
              error: 'miss',
            },
            codeMode: {
              success: true,
              toolCalls: 1,
              visibleToolCount: 2,
              listCatalogTokens: 2,
              runCodeRequestTokens: 3,
              runCodeResponseTokens: 2,
              totalContextTokens: 7,
              latencyMs: 12,
            },
            baseline: {
              success: true,
              toolCalls: 1,
              visibleToolCount: 8,
              catalogTokens: 40,
              directCallRequestTokens: 2,
              directCallResponseTokens: 2,
              totalContextTokens: 44,
              latencyMs: 15,
            },
          },
          {
            scenarioId: 'default-1',
            namespace: 'default',
            prompt: 'two',
            gateway: {
              success: true,
              searchUsed: true,
              searchCalls: 1,
              toolCalls: 2,
              visibleToolCount: 2,
              listCatalogTokens: 2,
              searchResponseTokens: 6,
              proxyCallRequestTokens: 2,
              proxyCallResponseTokens: 10,
              totalContextTokens: 20,
              latencyMs: 35,
            },
            codeMode: {
              success: true,
              toolCalls: 1,
              visibleToolCount: 2,
              listCatalogTokens: 2,
              runCodeRequestTokens: 3,
              runCodeResponseTokens: 4,
              totalContextTokens: 9,
              latencyMs: 18,
            },
            baseline: {
              success: true,
              toolCalls: 1,
              visibleToolCount: 8,
              catalogTokens: 40,
              directCallRequestTokens: 2,
              directCallResponseTokens: 2,
              totalContextTokens: 44,
              latencyMs: 18,
            },
          },
        ],
      },
    }

    const compatGateway = summarizeReportNamespace(report, 'compat', 'gateway')
    const defaultGateway = summarizeReportNamespace(report, 'default', 'gateway')

    expect(compatGateway.retrieval.recallAt3).toBe(0)
    expect(compatGateway.e2e.successRate).toBe(0)
    expect(defaultGateway.retrieval.recallAt3).toBe(1)
    expect(defaultGateway.e2e.successRate).toBe(1)
  })
})
