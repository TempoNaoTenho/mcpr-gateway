import { describe, it, expect } from 'vitest'
import { buildBootstrapWindow, buildBootstrapWindowFromConfig } from '../../src/session/bootstrap.js'
import { Mode, ToolRiskLevel } from '../../src/types/enums.js'
import type { Toolcard } from '../../src/types/tools.js'
import type { GatewayConfig } from '../../src/config/loader.js'

function makeToolcard(overrides: Partial<Toolcard> & Pick<Toolcard, 'name'>): Toolcard {
  return {
    name: overrides.name,
    description: `Description for ${overrides.name}`,
    inputSchema: {},
    serverId: 'server-1',
    namespace: 'gmail',
    retrievedAt: new Date().toISOString(),
    sanitized: true,
    riskLevel: ToolRiskLevel.Low,
    tags: [],
    quarantined: false,
    ...overrides,
  }
}

const defaultStarterPack = {
  preferredTags: ['read', 'email'],
  maxTools: 10,
  includeRiskLevels: [ToolRiskLevel.Low, ToolRiskLevel.Medium],
  includeModes: [Mode.Read, Mode.Write],
}

describe('buildBootstrapWindow', () => {
  it('returns [] when candidates is empty', () => {
    const result = buildBootstrapWindow([], defaultStarterPack, 4, Mode.Read)
    expect(result).toEqual([])
  })

  it('filters out high-risk candidates when not in includeRiskLevels', () => {
    const low = makeToolcard({ name: 'low-tool', riskLevel: ToolRiskLevel.Low })
    const high = makeToolcard({ name: 'high-tool', riskLevel: ToolRiskLevel.High })
    const result = buildBootstrapWindow([low, high], defaultStarterPack, 10, Mode.Read)
    expect(result.map((t) => t.name)).toContain('low-tool')
    expect(result.map((t) => t.name)).not.toContain('high-tool')
  })

  it('keeps high-risk candidates when includeRiskLevels includes High', () => {
    const high = makeToolcard({ name: 'high-tool', riskLevel: ToolRiskLevel.High })
    const pack = { ...defaultStarterPack, includeRiskLevels: [ToolRiskLevel.High] }
    const result = buildBootstrapWindow([high], pack, 10, Mode.Read)
    expect(result).toHaveLength(1)
  })

  it('filters out quarantined candidates even when their risk level is allowed', () => {
    const quarantined = makeToolcard({
      name: 'quarantined-tool',
      riskLevel: ToolRiskLevel.Low,
      quarantined: true,
    })
    const result = buildBootstrapWindow([quarantined], defaultStarterPack, 10, Mode.Read)
    expect(result).toEqual([])
  })

  it('returns [] when starter pack does not include the requested mode', () => {
    const readOnlyPack = { ...defaultStarterPack, includeModes: [Mode.Read] }
    const result = buildBootstrapWindow(
      [makeToolcard({ name: 'read-only-tool' })],
      readOnlyPack,
      10,
      Mode.Write,
    )
    expect(result).toEqual([])
  })

  it('preserves candidate order after starter-pack filtering', () => {
    const highScore = makeToolcard({ name: 'high-score', tags: ['read', 'email', 'extra'] })
    const lowScore = makeToolcard({ name: 'low-score', tags: ['read'] })
    const result = buildBootstrapWindow([lowScore, highScore], defaultStarterPack, 10, Mode.Read)
    expect(result.map((t) => t.name)).toEqual(['low-score', 'high-score'])
  })

  it('does not re-sort candidates that already arrived ranked', () => {
    const a = makeToolcard({ name: 'alpha', tags: ['read'] })
    const b = makeToolcard({ name: 'beta', tags: ['read'] })
    const c = makeToolcard({ name: 'gamma', tags: ['read'] })
    const result = buildBootstrapWindow([c, a, b], defaultStarterPack, 10, Mode.Read)
    expect(result.map((t) => t.name)).toEqual(['gamma', 'alpha', 'beta'])
  })

  it('respects bootstrapWindowSize limit', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeToolcard({ name: `tool-${i}` }),
    )
    const result = buildBootstrapWindow(candidates, defaultStarterPack, 3, Mode.Read)
    expect(result).toHaveLength(3)
  })

  it('respects starterPack.maxTools limit', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeToolcard({ name: `tool-${i}` }),
    )
    const pack = { ...defaultStarterPack, maxTools: 2 }
    const result = buildBootstrapWindow(candidates, pack, 100, Mode.Read)
    expect(result).toHaveLength(2)
  })

  it('applies min(bootstrapWindowSize, maxTools)', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeToolcard({ name: `tool-${i}` }),
    )
    const pack = { ...defaultStarterPack, maxTools: 3 }
    const result = buildBootstrapWindow(candidates, pack, 5, Mode.Read)
    expect(result).toHaveLength(3)
  })

  it('projected VisibleTool does not contain retrievedAt, sanitized, or summary', () => {
    const tc = makeToolcard({ name: 'test-tool', summary: 'a summary' })
    const result = buildBootstrapWindow([tc], defaultStarterPack, 10, Mode.Read)
    expect(result).toHaveLength(1)
    const tool = result[0] as Record<string, unknown>
    expect(tool['retrievedAt']).toBeUndefined()
    expect(tool['sanitized']).toBeUndefined()
    expect(tool['summary']).toBeUndefined()
  })

  it('is deterministic: same inputs produce same output', () => {
    const candidates = [
      makeToolcard({ name: 'c', tags: ['read'] }),
      makeToolcard({ name: 'a', tags: ['email', 'read'] }),
      makeToolcard({ name: 'b', tags: ['read'] }),
    ]
    const r1 = buildBootstrapWindow(candidates, defaultStarterPack, 10, Mode.Read)
    const r2 = buildBootstrapWindow(candidates, defaultStarterPack, 10, Mode.Read)
    expect(r1.map((t) => t.name)).toEqual(r2.map((t) => t.name))
  })

  it('VisibleTool contains expected fields', () => {
    const tc = makeToolcard({ name: 'my-tool', tags: ['read'], riskLevel: ToolRiskLevel.Low })
    const result = buildBootstrapWindow([tc], defaultStarterPack, 10, Mode.Read)
    expect(result[0]).toMatchObject({
      name: 'my-tool',
      serverId: 'server-1',
      namespace: 'gmail',
      riskLevel: ToolRiskLevel.Low,
      tags: ['read'],
    })
  })
})

describe('buildBootstrapWindowFromConfig', () => {
  it('falls back to the candidate pool when no starter pack exists for the namespace', () => {
    const config = {
      starterPacks: {},
      namespaces: {
        gmail: {
          allowedRoles: ['user'],
          bootstrapWindowSize: 2,
          candidatePoolSize: 16,
          allowedModes: [Mode.Read],
        },
      },
    } as GatewayConfig

    const result = buildBootstrapWindowFromConfig(
      [
        makeToolcard({ name: 'alpha' }),
        makeToolcard({ name: 'beta' }),
        makeToolcard({ name: 'gamma' }),
      ],
      config,
      'gmail',
      Mode.Read,
    )

    expect(result.map((tool) => tool.name)).toEqual(['alpha', 'beta'])
  })
})
