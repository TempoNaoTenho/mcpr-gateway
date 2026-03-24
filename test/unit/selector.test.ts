import { describe, expect, it } from 'vitest'
import { rerankCandidates } from '../../src/selector/scorer.js'
import { publishWindow } from '../../src/selector/publish.js'
import { SelectorEngine } from '../../src/selector/index.js'
import { rankToolsWithBm25 } from '../../src/selector/bm25.js'
import {
  DownstreamHealth,
  Mode,
  OutcomeClass,
  RefreshTriggerType,
  SourceTrustLevel,
  ToolRiskLevel,
} from '../../src/types/enums.js'
import type { Toolcard, VisibleTool } from '../../src/types/tools.js'
import type { RerankSignals } from '../../src/selector/scorer.js'
import type { ExecutionOutcome } from '../../src/types/execution.js'

function makeToolcard(overrides: Partial<Toolcard> & { name: string }): Toolcard {
  return {
    name: overrides.name,
    description: overrides.description ?? 'A tool',
    inputSchema: { type: 'object' },
    serverId: overrides.serverId ?? 'server-1',
    namespace: overrides.namespace ?? 'default',
    retrievedAt: new Date().toISOString(),
    sanitized: true,
    riskLevel: overrides.riskLevel ?? ToolRiskLevel.Low,
    tags: overrides.tags ?? [],
    summary: overrides.summary,
    sourceTrust: overrides.sourceTrust ?? SourceTrustLevel.Verified,
    namespaceHints: overrides.namespaceHints,
    estimatedLatency: overrides.estimatedLatency,
    quarantined: overrides.quarantined ?? false,
    quarantineReason: overrides.quarantineReason,
  }
}

function baseSignals(overrides: Partial<RerankSignals> = {}): RerankSignals {
  return {
    mode: Mode.Read,
    penalties: { write: 0.5, admin: 0.5, unhealthyDownstream: 0.5 },
    healthStates: {},
    recentOutcomes: [],
    starterPackHints: [],
    namespace: 'default',
    ...overrides,
  }
}

function makeOutcome(
  toolName: string,
  outcome: OutcomeClass,
  serverId = 'server-1',
): ExecutionOutcome {
  return {
    toolName,
    serverId,
    sessionId: 'sess-1',
    outcome,
    durationMs: 100,
    timestamp: new Date().toISOString(),
  }
}

function toVisible(tc: Toolcard): VisibleTool {
  return {
    name: tc.name,
    description: tc.description,
    inputSchema: tc.inputSchema,
    serverId: tc.serverId,
    namespace: tc.namespace,
    riskLevel: tc.riskLevel,
    tags: tc.tags,
  }
}

// ─── scorer ───────────────────────────────────────────────────────────────────

describe('rerankCandidates — trust bonus', () => {
  it('gives +1 to Internal and +0.5 to Verified, 0 to Untrusted', () => {
    const internal = makeToolcard({ name: 'tool-internal', sourceTrust: SourceTrustLevel.Internal })
    const verified = makeToolcard({ name: 'tool-verified', sourceTrust: SourceTrustLevel.Verified })
    const untrusted = makeToolcard({ name: 'tool-untrusted', sourceTrust: SourceTrustLevel.Untrusted })

    const results = rerankCandidates([internal, verified, untrusted], baseSignals())
    const byName = Object.fromEntries(results.map((r) => [r.toolcard.name, r]))

    expect(byName['tool-internal'].breakdown.trustBonus).toBe(1)
    expect(byName['tool-verified'].breakdown.trustBonus).toBe(0.5)
    expect(byName['tool-untrusted'].breakdown.trustBonus).toBeUndefined()

    expect(byName['tool-internal'].score).toBeGreaterThan(byName['tool-verified'].score)
    expect(byName['tool-verified'].score).toBeGreaterThan(byName['tool-untrusted'].score)
  })
})

describe('rerankCandidates — health penalty', () => {
  it('penalizes Degraded=-2, Offline=-5, Unknown=-0.5', () => {
    const tc = makeToolcard({ name: 'tool-a', serverId: 'srv' })
    const signals = baseSignals({
      healthStates: { srv: DownstreamHealth.Degraded },
    })
    const [entry] = rerankCandidates([tc], signals)
    expect(entry.breakdown.healthPenalty).toBe(-2)
  })

  it('penalizes Offline -5', () => {
    const tc = makeToolcard({ name: 'tool-a', serverId: 'srv' })
    const [entry] = rerankCandidates([tc], baseSignals({ healthStates: { srv: DownstreamHealth.Offline } }))
    expect(entry.breakdown.healthPenalty).toBe(-5)
  })

  it('does not penalize Healthy', () => {
    const tc = makeToolcard({ name: 'tool-a', serverId: 'srv' })
    const [entry] = rerankCandidates([tc], baseSignals({ healthStates: { srv: DownstreamHealth.Healthy } }))
    expect(entry.breakdown.healthPenalty).toBeUndefined()
  })
})

describe('rerankCandidates — latency penalty', () => {
  it('deducts floor(latency/1000) points', () => {
    const tc = makeToolcard({ name: 'tool-a', estimatedLatency: 2500 })
    const [entry] = rerankCandidates([tc], baseSignals())
    expect(entry.breakdown.latencyPenalty).toBe(-2)
  })

  it('no penalty when latency is 0', () => {
    const tc = makeToolcard({ name: 'tool-a', estimatedLatency: 0 })
    const [entry] = rerankCandidates([tc], baseSignals())
    expect(entry.breakdown.latencyPenalty).toBeUndefined()
  })
})

describe('rerankCandidates — failure penalty', () => {
  it('applies -2 per failure, capped at -6', () => {
    const tc = makeToolcard({ name: 'write_file', serverId: 'srv' })
    const outcomes = [
      makeOutcome('write_file', OutcomeClass.ToolError, 'srv'),
      makeOutcome('write_file', OutcomeClass.Timeout, 'srv'),
      makeOutcome('write_file', OutcomeClass.TransportError, 'srv'),
      makeOutcome('write_file', OutcomeClass.ToolError, 'srv'),
    ]
    const [entry] = rerankCandidates([tc], baseSignals({ recentOutcomes: outcomes }))
    expect(entry.breakdown.failurePenalty).toBe(-6)
  })

  it('no failure penalty for successes', () => {
    const tc = makeToolcard({ name: 'write_file', serverId: 'srv' })
    const outcomes = [makeOutcome('write_file', OutcomeClass.Success, 'srv')]
    const [entry] = rerankCandidates([tc], baseSignals({ recentOutcomes: outcomes }))
    expect(entry.breakdown.failurePenalty).toBeUndefined()
  })
})

describe('rerankCandidates — mode penalty', () => {
  it('penalizes High risk tools in Read mode', () => {
    const highRisk = makeToolcard({ name: 'delete_all', riskLevel: ToolRiskLevel.High })
    const lowRisk = makeToolcard({ name: 'read_file', riskLevel: ToolRiskLevel.Low })
    const results = rerankCandidates([highRisk, lowRisk], baseSignals({ mode: Mode.Read, penalties: { write: 0.5, admin: 0.5, unhealthyDownstream: 0.5 } }))
    const byName = Object.fromEntries(results.map((r) => [r.toolcard.name, r]))
    expect(byName['delete_all'].breakdown.modePenalty).toBe(-2.5) // -(0.5 * 5)
    expect(byName['read_file'].breakdown.modePenalty).toBeUndefined()
  })

  it('no mode penalty in Write mode', () => {
    const highRisk = makeToolcard({ name: 'delete_all', riskLevel: ToolRiskLevel.High })
    const [entry] = rerankCandidates([highRisk], baseSignals({ mode: Mode.Write }))
    expect(entry.breakdown.modePenalty).toBeUndefined()
  })
})

describe('rerankCandidates — redundancy penalty', () => {
  it('applies -1 to second tool sharing first token', () => {
    const tc1 = makeToolcard({ name: 'read_file' })
    const tc2 = makeToolcard({ name: 'read_dir' })
    const tc3 = makeToolcard({ name: 'write_file' })

    // Give tc1 and tc2 same score baseline by using Internal trust for both
    const tc1i = { ...tc1, sourceTrust: SourceTrustLevel.Internal }
    const tc2i = { ...tc2, sourceTrust: SourceTrustLevel.Internal }

    const results = rerankCandidates([tc1i, tc2i, tc3], baseSignals())
    const byName = Object.fromEntries(results.map((r) => [r.toolcard.name, r]))

    // One of the "read_*" tools should have redundancyPenalty, the other should not
    const readToolPenalties = [
      byName['read_file'].breakdown.redundancyPenalty,
      byName['read_dir'].breakdown.redundancyPenalty,
    ]
    expect(readToolPenalties.filter((p) => p === -1)).toHaveLength(1)
    expect(byName['write_file'].breakdown.redundancyPenalty).toBeUndefined()
  })
})

// ─── publish ──────────────────────────────────────────────────────────────────

describe('publishWindow — top-N selection', () => {
  it('selects top-N tools when window size is limited', () => {
    const tools = Array.from({ length: 10 }, (_, i) => makeToolcard({ name: `tool-${i}` }))
    const ranked = rerankCandidates(tools, baseSignals())
    const { selected } = publishWindow(ranked, 4, [])
    expect(selected).toHaveLength(4)
  })

  it('returns fewer tools if not enough candidates', () => {
    const tools = [makeToolcard({ name: 'tool-a' }), makeToolcard({ name: 'tool-b' })]
    const ranked = rerankCandidates(tools, baseSignals())
    const { selected } = publishWindow(ranked, 6, [])
    expect(selected).toHaveLength(2)
  })
})

describe('publishWindow — stability guardrail', () => {
  it('retains current window tool when delta < STABILITY_THRESHOLD', () => {
    // tool-old: score would be slightly below top-3 but within threshold
    const toolA = makeToolcard({ name: 'tool-a', sourceTrust: SourceTrustLevel.Internal })
    const toolB = makeToolcard({ name: 'tool-b', sourceTrust: SourceTrustLevel.Internal })
    const toolC = makeToolcard({ name: 'tool-c', sourceTrust: SourceTrustLevel.Internal })
    const toolOld = makeToolcard({ name: 'tool-old', sourceTrust: SourceTrustLevel.Verified })

    const ranked = rerankCandidates([toolA, toolB, toolC, toolOld], baseSignals())
    // tool-old is 4th (Verified = 0.5 trust, Internal = 1.0)
    // All Internal tools score the same — tool-old has 0.5 vs 1.0 = delta of 0.5 < threshold 1.0
    // So if tool-old is in current window, it should be retained

    const currentWindow: VisibleTool[] = [toVisible(toolOld)]
    const { selected, reasoning } = publishWindow(ranked, 3, currentWindow)

    const selectedNames = selected.map((t) => t.name)
    expect(selectedNames).toContain('tool-old')
    expect(reasoning).toMatch(/retained/)
  })

  it('replaces current window tool when new tool score is clearly higher', () => {
    // Internal trust = 1.0 bonus; old tool has Untrusted = 0
    const newTool = makeToolcard({ name: 'new-tool', sourceTrust: SourceTrustLevel.Internal, tags: ['search', 'read', 'fast'] })
    const oldTool = makeToolcard({ name: 'old-tool', sourceTrust: SourceTrustLevel.Untrusted })

    // Give newTool much higher score via hint tags
    const ranked = rerankCandidates(
      [newTool, oldTool],
      baseSignals({ starterPackHints: ['search', 'read', 'fast'] }),
    )

    const currentWindow: VisibleTool[] = [toVisible(oldTool)]
    const { selected } = publishWindow(ranked, 1, currentWindow)

    expect(selected[0].name).toBe('new-tool')
  })
})

describe('publishWindow — VisibleTool conversion', () => {
  it('projects only visible fields from toolcard', () => {
    const tc = makeToolcard({ name: 'my-tool', tags: ['read'], riskLevel: ToolRiskLevel.Low })
    const ranked = rerankCandidates([tc], baseSignals())
    const { selected } = publishWindow(ranked, 1, [])
    const tool = selected[0]

    expect(tool.name).toBe('my-tool')
    expect(tool.serverId).toBeDefined()
    expect(tool.namespace).toBeDefined()
    expect(tool.riskLevel).toBe(ToolRiskLevel.Low)
    expect(tool.tags).toEqual(['read'])
    // Should NOT have toolcard-only fields
    expect((tool as Record<string, unknown>).quarantined).toBeUndefined()
    expect((tool as Record<string, unknown>).sourceTrust).toBeUndefined()
  })
})

// ─── engine ───────────────────────────────────────────────────────────────────

describe('SelectorEngine — select', () => {
  it('returns SelectorDecision with correct shape', async () => {
    const engine = new SelectorEngine()
    const tools = [
      makeToolcard({ name: 'read_file', tags: ['read'] }),
      makeToolcard({ name: 'write_file', tags: ['write'], riskLevel: ToolRiskLevel.High }),
      makeToolcard({ name: 'list_dir', tags: ['read'] }),
    ]

    const decision = await engine.select({
      sessionId: 'sess-123',
      namespace: 'default',
      mode: Mode.Read,
      candidates: tools,
      policyConfig: {
        selector: { penalties: { write: 0.5, admin: 0.5, unhealthyDownstream: 0.5 } },
      },
    })

    expect(decision.selected).toHaveLength(3)
    expect(decision.triggeredBy).toBe(RefreshTriggerType.ExplicitRequest)
    expect(decision.timestamp).toBeDefined()
    expect(decision.reasoning).toContain('Selected')
  })

  it('publishes all ranked candidates (full effective window)', async () => {
    const engine = new SelectorEngine()
    const tools = Array.from({ length: 10 }, (_, i) => makeToolcard({ name: `tool-${i}` }))

    const decision = await engine.select({
      sessionId: 'sess-abc',
      namespace: 'default',
      mode: Mode.Read,
      candidates: tools,
      policyConfig: {},
    })

    expect(decision.selected).toHaveLength(10)
    expect(decision.trace?.windowSizeUsed).toBe(10)
  })

  it('keeps one cross-domain exploration slot when focus is active', async () => {
    const engine = new SelectorEngine()
    const tools = [
      makeToolcard({ name: 'read_file', tags: ['file'] }),
      makeToolcard({ name: 'write_file', tags: ['file'] }),
      makeToolcard({ name: 'slack_send_message', tags: ['slack'] }),
    ]

    const decision = await engine.select({
      sessionId: 'sess-focus',
      namespace: 'default',
      mode: Mode.Read,
      candidates: tools,
      recentOutcomes: [
        makeOutcome('read_file', OutcomeClass.Success),
        makeOutcome('write_file', OutcomeClass.Success),
      ],
      policyConfig: {
        selector: {
          penalties: { write: 0.5, admin: 0.5, unhealthyDownstream: 0.5 },
          focus: {
            enabled: true,
            lookback: 5,
            minDominantSuccesses: 2,
            reserveSlots: 1,
            crossDomainPenalty: 1,
          },
        },
      },
    })

    expect(decision.selected.map((tool) => tool.name)).toContain('slack_send_message')
    expect(decision.trace?.focus?.dominantCapability).toBe('files')
  })
})

describe('SelectorEngine — rerank', () => {
  it('returns tools ordered by BM25 score desc', async () => {
    const engine = new SelectorEngine()
    const tools = [
      makeToolcard({ name: 'search_files', tags: ['search'], description: 'Search local files quickly' }),
      makeToolcard({ name: 'read_file', tags: ['read'] }),
      makeToolcard({ name: 'search_docs', tags: ['search', 'docs'], description: 'Find docs and documentation pages' }),
    ]

    const ranked = await engine.rerank(tools, 'documentation search')

    expect(ranked[0].name).toBe('search_docs')
    expect(ranked[ranked.length - 1].name).toBe('read_file')
  })
})

describe('rankToolsWithBm25', () => {
  it('uses name, description and tags to rank multi-term queries', () => {
    const tools = [
      makeToolcard({ name: 'read_ticket', description: 'Read one ticket', tags: ['ticket'] }),
      makeToolcard({ name: 'search_docs', description: 'Search documentation for product guides', tags: ['docs', 'search'] }),
      makeToolcard({ name: 'list_users', description: 'List users in the workspace', tags: ['users'] }),
    ]

    const ranked = rankToolsWithBm25(tools, 'product documentation search')

    expect(ranked[0]?.toolcard.name).toBe('search_docs')
    expect(ranked[0]?.matchedTerms).toContain('documentation')
    expect(ranked[0]?.matchedTerms).toContain('search')
  })

  it('returns stable alphabetical order when query is empty', () => {
    const tools = [
      makeToolcard({ name: 'z_tool' }),
      makeToolcard({ name: 'a_tool' }),
    ]

    const ranked = rankToolsWithBm25(tools, '')

    expect(ranked.map((entry) => entry.toolcard.name)).toEqual(['a_tool', 'z_tool'])
    expect(ranked.every((entry) => entry.score === 0)).toBe(true)
  })
})
