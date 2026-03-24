import { describe, expect, it } from 'vitest'
import { SelectorEngine } from '../../src/selector/index.js'
import { Mode, RefreshTriggerType, SourceTrustLevel, ToolRiskLevel } from '../../src/types/enums.js'
import type { Toolcard } from '../../src/types/tools.js'

function makeToolcard(name: string, overrides: Partial<Toolcard> = {}): Toolcard {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object' },
    serverId: 'server-1',
    namespace: 'default',
    retrievedAt: new Date().toISOString(),
    sanitized: true,
    riskLevel: ToolRiskLevel.Low,
    tags: [],
    sourceTrust: SourceTrustLevel.Verified,
    quarantined: false,
    ...overrides,
  }
}

describe('SelectorEngine — trace', () => {
  it('populates trace with candidatePoolSize', async () => {
    const engine = new SelectorEngine()
    const tools = Array.from({ length: 5 }, (_, i) => makeToolcard(`tool-${i}`))

    const decision = await engine.select({
      sessionId: 'sess-1',
      namespace: 'default',
      mode: Mode.Read,
      candidates: tools,
      policyConfig: {},
    })

    expect(decision.trace).toBeDefined()
    expect(decision.trace!.candidatePoolSize).toBe(5)
    expect(decision.trace!.windowSizeUsed).toBe(5)
  })

  it('populates rankedList for all candidates', async () => {
    const engine = new SelectorEngine()
    const tools = [
      makeToolcard('read_file', { tags: ['read'] }),
      makeToolcard('write_file', { tags: ['write'], riskLevel: ToolRiskLevel.High }),
      makeToolcard('list_dir', { tags: ['read'] }),
    ]

    const decision = await engine.select({
      sessionId: 'sess-2',
      namespace: 'default',
      mode: Mode.Read,
      candidates: tools,
      policyConfig: {},
    })

    expect(decision.trace!.rankedList).toHaveLength(3)
    expect(decision.trace!.rankedList.every((e) => typeof e.score === 'number')).toBe(true)
    expect(decision.trace!.rankedList.every((e) => typeof e.toolName === 'string')).toBe(true)
    expect(decision.trace!.rankedList.every((e) => typeof e.serverId === 'string')).toBe(true)
    expect(decision.trace!.rankedList.every((e) => typeof e.breakdown === 'object')).toBe(true)
  })

  it('has no below-window exclusions when all candidates fit the effective window', async () => {
    const engine = new SelectorEngine()
    const tools = Array.from({ length: 5 }, (_, i) => makeToolcard(`tool-${i}`))

    const decision = await engine.select({
      sessionId: 'sess-3',
      namespace: 'default',
      mode: Mode.Read,
      candidates: tools,
      policyConfig: {},
    })

    expect(decision.trace!.exclusionReasons.filter((e) => e.reason.includes('below window size'))).toHaveLength(0)
  })

  it('records correct triggerUsed in trace', async () => {
    const engine = new SelectorEngine()
    const tools = [makeToolcard('tool-a')]

    const decision = await engine.select({
      sessionId: 'sess-4',
      namespace: 'default',
      mode: Mode.Read,
      candidates: tools,
      policyConfig: {
        triggeredBy: RefreshTriggerType.ErrorThreshold,
      },
    })

    expect(decision.trace!.triggerUsed).toBe(RefreshTriggerType.ErrorThreshold)
  })

  it('records penaltiesApplied from policy', async () => {
    const engine = new SelectorEngine()
    const tools = [makeToolcard('tool-a')]

    const decision = await engine.select({
      sessionId: 'sess-5',
      namespace: 'default',
      mode: Mode.Read,
      candidates: tools,
      policyConfig: {
        selector: { penalties: { write: 0.3, admin: 0.7, unhealthyDownstream: 0.9 } },
      },
    })

    expect(decision.trace!.penaltiesApplied['write']).toBe(0.3)
    expect(decision.trace!.penaltiesApplied['admin']).toBe(0.7)
    expect(decision.trace!.penaltiesApplied['unhealthyDownstream']).toBe(0.9)
  })

  it('filtersApplied always includes namespace, mode, health', async () => {
    const engine = new SelectorEngine()
    const decision = await engine.select({
      sessionId: 'sess-6',
      namespace: 'default',
      mode: Mode.Read,
      candidates: [makeToolcard('tool-x')],
      policyConfig: {},
    })

    expect(decision.trace!.filtersApplied).toContain('namespace')
    expect(decision.trace!.filtersApplied).toContain('mode')
    expect(decision.trace!.filtersApplied).toContain('health')
  })
})
