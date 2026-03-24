import { describe, expect, it } from 'vitest'
import { buildCandidatePool } from '../../src/candidate/index.js'
import { toolCandidateKey } from '../../src/candidate/lexical.js'
import { DownstreamHealth, Mode, OutcomeClass, SourceTrustLevel, ToolRiskLevel } from '../../src/types/enums.js'
import type { Toolcard } from '../../src/types/tools.js'
import type { CandidateInput } from '../../src/types/candidate.js'

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

function baseInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    namespace: 'default',
    mode: Mode.Read,
    candidatePoolSize: 10,
    currentToolWindow: [],
    recentOutcomes: [],
    starterPackHints: [],
    includeRiskLevels: [ToolRiskLevel.Low, ToolRiskLevel.Medium],
    allToolcards: [],
    disabledToolKeys: new Set(),
    ...overrides,
  }
}

describe('buildCandidatePool', () => {
  it('excludes quarantined tools', () => {
    const tc = makeToolcard({ name: 'bad_tool', quarantined: true })
    const result = buildCandidatePool(baseInput({ allToolcards: [tc] }))
    expect(result.pool).toHaveLength(0)
    expect(result.debug[0]).toMatchObject({
      toolName: 'bad_tool',
      serverId: 'server-1',
      included: false,
      filterReason: 'quarantined',
    })
  })

  it('excludes tools from wrong namespace', () => {
    const tc = makeToolcard({ name: 'other_tool', namespace: 'other' })
    const result = buildCandidatePool(baseInput({ allToolcards: [tc] }))
    expect(result.pool).toHaveLength(0)
    expect(result.debug[0]).toMatchObject({
      toolName: 'other_tool',
      serverId: 'server-1',
      included: false,
      filterReason: 'namespace mismatch',
    })
  })

  it('excludes tools disabled for the namespace', () => {
    const tc = makeToolcard({ name: 'blocked', serverId: 'srv-a' })
    const disabled = new Set([toolCandidateKey('srv-a', 'blocked')])
    const result = buildCandidatePool(baseInput({ allToolcards: [tc], disabledToolKeys: disabled }))
    expect(result.pool).toHaveLength(0)
    expect(result.debug[0]).toMatchObject({
      toolName: 'blocked',
      serverId: 'srv-a',
      included: false,
      filterReason: 'disabled in namespace',
    })
  })

  it('excludes tools with disallowed risk level', () => {
    const tc = makeToolcard({ name: 'high_risk', riskLevel: ToolRiskLevel.High })
    const result = buildCandidatePool(baseInput({ allToolcards: [tc], includeRiskLevels: [ToolRiskLevel.Low] }))
    expect(result.pool).toHaveLength(0)
    expect(result.debug[0]).toMatchObject({ filterReason: 'risk level not allowed' })
  })

  it('excludes tools whose server is offline', () => {
    const tc = makeToolcard({ name: 'offline_tool', serverId: 'server-down' })
    const result = buildCandidatePool(
      baseInput({
        allToolcards: [tc],
        healthStates: { 'server-down': DownstreamHealth.Offline },
      }),
    )
    expect(result.pool).toHaveLength(0)
    expect(result.debug[0]).toMatchObject({ filterReason: 'server offline' })
  })

  it('includes healthy tools that pass all filters', () => {
    const tc = makeToolcard({ name: 'good_tool' })
    const result = buildCandidatePool(baseInput({ allToolcards: [tc] }))
    expect(result.pool).toHaveLength(1)
    expect(result.debug[0]).toMatchObject({ toolName: 'good_tool', serverId: 'server-1', included: true })
  })

  it('gives higher score to tools with preferred tags', () => {
    const preferred = makeToolcard({ name: 'preferred', tags: ['email'] })
    const plain = makeToolcard({ name: 'plain' })
    const result = buildCandidatePool(
      baseInput({ allToolcards: [plain, preferred], starterPackHints: ['email'] }),
    )
    const preferredEntry = result.debug.find((d) => d.toolName === 'preferred')!
    const plainEntry = result.debug.find((d) => d.toolName === 'plain')!
    expect(preferredEntry.score).toBeGreaterThan(plainEntry.score)
    expect(preferredEntry.scoreBreakdown?.['retrieval.context.starterPackAffinity']).toBeGreaterThan(0)
  })

  it('prioritizes exact recent successful tools', () => {
    const tc = makeToolcard({ name: 'recent_tool' })
    const result = buildCandidatePool(
      baseInput({
        allToolcards: [tc],
        recentOutcomes: [
          {
            toolName: 'recent_tool',
            serverId: 'server-1',
            sessionId: 'sess-1',
            outcome: OutcomeClass.Success,
            durationMs: 100,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    )
    const entry = result.debug.find((d) => d.toolName === 'recent_tool')!
    expect(entry.scoreBreakdown?.['retrieval.context.exactRecentReuse']).toBe(1)
    expect(entry.scoreBreakdown?.['retrieval.context.recentServerAffinity']).toBe(1)
  })

  it('gives sibling affinity to tools sharing the first token with a recent success', () => {
    const neighbor = makeToolcard({ name: 'email_send' })
    const result = buildCandidatePool(
      baseInput({
        allToolcards: [neighbor],
        recentOutcomes: [
          {
            toolName: 'email_read',
            serverId: 'server-1',
            sessionId: 'sess-1',
            outcome: OutcomeClass.Success,
            durationMs: 50,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    )
    const entry = result.debug.find((d) => d.toolName === 'email_send')!
    expect(entry.scoreBreakdown?.['retrieval.context.siblingAffinity']).toBe(1)
  })

  it('does not classify the same recent tool as a sibling', () => {
    const tc = makeToolcard({ name: 'email_read' })
    const result = buildCandidatePool(
      baseInput({
        allToolcards: [tc],
        recentOutcomes: [
          {
            toolName: 'email_read',
            serverId: 'server-1',
            sessionId: 'sess-1',
            outcome: OutcomeClass.Success,
            durationMs: 50,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    )
    const entry = result.debug.find((d) => d.toolName === 'email_read')!
    expect(entry.scoreBreakdown?.['retrieval.context.siblingAffinity']).toBe(0)
    expect(entry.scoreBreakdown?.['retrieval.context.exactRecentReuse']).toBe(1)
  })

  it('truncates pool to candidatePoolSize', () => {
    const tools = Array.from({ length: 5 }, (_, i) => makeToolcard({ name: `tool_${i}` }))
    const result = buildCandidatePool(baseInput({ allToolcards: tools, candidatePoolSize: 3 }))
    expect(result.pool).toHaveLength(3)
    const excluded = result.debug.filter((d) => d.filterReason === 'below pool size threshold')
    expect(excluded).toHaveLength(2)
  })

  it('debug contains an entry for every toolcard', () => {
    const tools = [
      makeToolcard({ name: 'tool_a' }),
      makeToolcard({ name: 'tool_b', quarantined: true }),
      makeToolcard({ name: 'tool_c', namespace: 'other' }),
    ]
    const result = buildCandidatePool(baseInput({ allToolcards: tools }))
    expect(result.debug).toHaveLength(3)
    const names = result.debug.map((d) => d.toolName)
    expect(names).toContain('tool_a')
    expect(names).toContain('tool_b')
    expect(names).toContain('tool_c')
  })

  it('pool size is larger than bootstrapWindowSize when configured correctly', () => {
    const tools = Array.from({ length: 10 }, (_, i) => makeToolcard({ name: `tool_${i}` }))
    const bootstrapWindowSize = 3
    const candidatePoolSize = 8
    const result = buildCandidatePool(baseInput({ allToolcards: tools, candidatePoolSize }))
    expect(result.pool.length).toBeGreaterThan(bootstrapWindowSize)
    expect(result.pool.length).toBe(candidatePoolSize)
  })

  it('scores and truncates duplicate tool names independently by serverId', () => {
    const serverA = makeToolcard({ name: 'shared_tool', serverId: 'server-a' })
    const serverB = makeToolcard({ name: 'shared_tool', serverId: 'server-b' })

    const result = buildCandidatePool(
      baseInput({
        allToolcards: [serverA, serverB],
        candidatePoolSize: 1,
        recentOutcomes: [
          {
            toolName: 'shared_tool',
            serverId: 'server-a',
            sessionId: 'sess-1',
            outcome: OutcomeClass.Success,
            durationMs: 10,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    )

    expect(result.pool).toEqual([serverA])

    const serverADebug = result.debug.find((d) => d.toolName === 'shared_tool' && d.serverId === 'server-a')
    const serverBDebug = result.debug.find((d) => d.toolName === 'shared_tool' && d.serverId === 'server-b')

    expect(serverADebug).toMatchObject({
      toolName: 'shared_tool',
      serverId: 'server-a',
      included: true,
    })
    expect(serverADebug?.scoreBreakdown?.['retrieval.context.exactRecentReuse']).toBe(1)
    expect(serverADebug?.scoreBreakdown?.['retrieval.context.recentServerAffinity']).toBe(1)
    expect(serverBDebug).toMatchObject({
      toolName: 'shared_tool',
      serverId: 'server-b',
      included: false,
      filterReason: 'below pool size threshold',
    })
    expect(serverBDebug?.scoreBreakdown?.['retrieval.context.exactRecentReuse']).toBe(0)
  })

  it('uses serverId as a soft domain signal when selecting between similar tools', () => {
    const docsServer = makeToolcard({ name: 'search', serverId: 'context7-docs' })
    const plainServer = makeToolcard({ name: 'search', serverId: 'utility' })

    const result = buildCandidatePool(
      baseInput({
        allToolcards: [plainServer, docsServer],
        starterPackHints: ['docs'],
      }),
    )

    expect(result.pool[0]).toEqual(docsServer)
    const docsEntry = result.debug.find((d) => d.toolName === 'search' && d.serverId === 'context7-docs')
    expect(docsEntry?.scoreBreakdown?.['retrieval.bm25.serverId.rrf']).toBeGreaterThan(0)
  })

  it('prioritizes tools whose metadata matches the initial session intent', () => {
    const docsTool = makeToolcard({
      name: 'resolve_library_reference',
      description: 'Read API docs and SDK reference',
      tags: ['documentation', 'api'],
      serverId: 'docs-hub',
    })
    const webTool = makeToolcard({
      name: 'extract_web_page',
      description: 'Browse a website and extract HTML content',
      tags: ['browser', 'web'],
      serverId: 'web-hub',
    })

    const result = buildCandidatePool(
      baseInput({
        allToolcards: [webTool, docsTool],
        initialIntentText: 'Need SDK API documentation for FastMCP',
      }),
    )

    expect(result.pool[0]).toEqual(docsTool)
    const docsEntry = result.debug.find((d) => d.toolName === docsTool.name && d.serverId === docsTool.serverId)
    const webEntry = result.debug.find((d) => d.toolName === webTool.name && d.serverId === webTool.serverId)
    expect(docsEntry?.scoreBreakdown?.['retrieval.context.initialIntentAffinity']).toBeGreaterThan(0)
    expect((docsEntry?.score ?? 0)).toBeGreaterThan(webEntry?.score ?? 0)
  })
})
