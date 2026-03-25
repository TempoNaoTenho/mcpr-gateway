import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeToolRecord } from '../../src/registry/normalize.js'
import { DownstreamRegistry } from '../../src/registry/registry.js'
import type { DownstreamServer } from '../../src/types/server.js'
import type { ToolSchema } from '../../src/types/tools.js'
import { SourceTrustLevel, StdioInteractiveAuthStatus } from '../../src/types/enums.js'

// Mock transports at the module level so refreshTools doesn't make real network calls
vi.mock('../../src/registry/transport/http.js', () => ({
  fetchToolsHttp: vi.fn(),
}))
vi.mock('../../src/registry/transport/stdio.js', () => ({
  fetchToolsStdio: vi.fn(),
  startToolsListStdioSession: vi.fn(),
}))

import { fetchToolsHttp } from '../../src/registry/transport/http.js'
import { fetchToolsStdio, startToolsListStdioSession } from '../../src/registry/transport/stdio.js'

const makeServer = (overrides: Partial<DownstreamServer> = {}): DownstreamServer => ({
  id: 'test-server',
  namespaces: ['test'],
  transport: 'http',
  url: 'http://localhost:9999',
  enabled: true,
  trustLevel: SourceTrustLevel.Verified,
  ...overrides,
})

const makeRawTool = (overrides: Partial<ToolSchema> = {}): ToolSchema => ({
  name: 'my_tool',
  description: 'Does stuff',
  inputSchema: { type: 'object', properties: {} },
  ...overrides,
})

// --- normalizeToolRecord ---

describe('normalizeToolRecord', () => {
  it('maps raw tool fields to ToolRecord correctly', () => {
    const server = makeServer()
    const raw = makeRawTool()
    const before = new Date()
    const record = normalizeToolRecord(raw, server)
    const after = new Date()

    expect(record.name).toBe('my_tool')
    expect(record.description).toBe('Does stuff')
    expect(record.inputSchema).toEqual({ type: 'object', properties: {} })
    expect(record.serverId).toBe('test-server')
    expect(record.namespace).toBe('test')
    expect(record.sanitized).toBe(false)

    const retrievedAt = new Date(record.retrievedAt)
    expect(retrievedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(retrievedAt.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  it('sets sanitized=false always', () => {
    const record = normalizeToolRecord(makeRawTool(), makeServer())
    expect(record.sanitized).toBe(false)
  })

  it('preserves optional description when absent', () => {
    const raw = makeRawTool({ description: undefined })
    const record = normalizeToolRecord(raw, makeServer())
    expect(record.description).toBeUndefined()
  })

  it('retrievedAt is a valid ISO string', () => {
    const record = normalizeToolRecord(makeRawTool(), makeServer())
    expect(() => new Date(record.retrievedAt)).not.toThrow()
    expect(record.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('throws if raw tool is invalid (missing name)', () => {
    expect(() => normalizeToolRecord({ inputSchema: {} }, makeServer())).toThrow()
  })
})

// --- DownstreamRegistry ---

describe('DownstreamRegistry.getTools()', () => {
  it('returns [] before any refresh', async () => {
    const reg = new DownstreamRegistry()
    const tools = await reg.getTools('unknown-server')
    expect(tools).toEqual([])
  })
})

describe('DownstreamRegistry.getToolsByNamespace()', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  it('returns the same server tools for each assigned namespace with the queried namespace applied', async () => {
    const server = makeServer({ namespaces: ['all', 'context7'] })
    vi.mocked(fetchToolsHttp).mockResolvedValue([makeRawTool({ name: 'resolve-library-id' })])

    const reg = new DownstreamRegistry()
    await reg.start([server])

    const allRecords = reg.getToolsByNamespace('all')
    expect(allRecords).toHaveLength(1)
    expect(allRecords[0]?.server.id).toBe('test-server')
    expect(allRecords[0]?.records.map((record) => record.namespace)).toEqual(['all'])

    const context7Records = reg.getToolsByNamespace('context7')
    expect(context7Records).toHaveLength(1)
    expect(context7Records[0]?.records.map((record) => record.namespace)).toEqual(['context7'])
  })
})

describe('DownstreamRegistry.refreshTools()', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  it('fetches, normalizes and caches tool records', async () => {
    const server = makeServer()
    const rawTools: ToolSchema[] = [makeRawTool(), makeRawTool({ name: 'other_tool' })]

    const reg = new DownstreamRegistry()
    vi.mocked(fetchToolsHttp).mockResolvedValue(rawTools)
    await reg.start([server])

    const records = await reg.refreshTools(server.id)
    expect(records).toHaveLength(2)
    expect(records[0].name).toBe('my_tool')
    expect(records[1].name).toBe('other_tool')
    expect(records[0].serverId).toBe('test-server')

    const cached = await reg.getTools(server.id)
    expect(cached).toEqual(records)
  })

  it('throws for unknown server id', async () => {
    const reg = new DownstreamRegistry()
    await expect(reg.refreshTools('does-not-exist')).rejects.toThrow('Unknown server')
  })

  it('uses the configured response timeout for HTTP discovery', async () => {
    const server = makeServer()
    const rawTools: ToolSchema[] = [makeRawTool()]

    vi.mocked(fetchToolsHttp).mockResolvedValue(rawTools)

    const reg = new DownstreamRegistry()
    await reg.start([server], {
      timeouts: { connectMs: 5000, responseMs: 1234, totalMs: 30000 },
      rateLimit: {
        perSession: { maxRequests: 100, windowSeconds: 60 },
        perUser: { maxRequests: 500, windowSeconds: 60 },
        perDownstreamConcurrency: 10,
      },
      circuitBreaker: {
        degradedAfterFailures: 3,
        offlineAfterFailures: 5,
        resetAfterSeconds: 60,
      },
    })

    expect(fetchToolsHttp).toHaveBeenCalledWith(server, 1234)

    vi.mocked(fetchToolsHttp).mockClear()
    await reg.refreshTools(server.id)
    expect(fetchToolsHttp).toHaveBeenCalledWith(server, 1234)
  })

  it('refreshes stdio servers when requested explicitly', async () => {
    const server = makeServer({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'fake-server'],
      url: undefined,
    })
    const rawTools: ToolSchema[] = [makeRawTool()]

    const reg = new DownstreamRegistry()
    vi.mocked(fetchToolsStdio).mockResolvedValue(rawTools)
    await reg.start([server])

    const records = await reg.refreshTools(server.id)
    expect(records).toHaveLength(1)
    expect(fetchToolsStdio).toHaveBeenCalledWith(server)
  })

  it('blocks one-shot refresh while interactive stdio auth is pending', async () => {
    const server = makeServer({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'fake-server'],
      url: undefined,
      stdioInteractiveAuth: { enabled: true },
    })

    let resolveTools: ((tools: ToolSchema[]) => void) | undefined
    vi.mocked(startToolsListStdioSession).mockImplementation(() => ({
      completion: new Promise<ToolSchema[]>((resolve) => {
        resolveTools = resolve
      }),
      cancel: vi.fn(),
    }))

    const reg = new DownstreamRegistry()
    vi.mocked(fetchToolsStdio).mockResolvedValue([makeRawTool()])
    await reg.start([server])

    const state = await reg.startStdioInteractiveAuth(server.id)
    expect(state.status).toBe(StdioInteractiveAuthStatus.Starting)

    await expect(reg.refreshTools(server.id)).rejects.toThrow('Interactive authentication is already in progress')

    resolveTools?.([makeRawTool()])
  })

  it('caches tools when interactive stdio auth completes', async () => {
    const server = makeServer({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'fake-server'],
      url: undefined,
      stdioInteractiveAuth: { enabled: true },
    })

    let resolveTools: ((tools: ToolSchema[]) => void) | undefined
    vi.mocked(startToolsListStdioSession).mockImplementation(() => ({
      completion: new Promise<ToolSchema[]>((resolve) => {
        resolveTools = resolve
      }),
      cancel: vi.fn(),
    }))

    const reg = new DownstreamRegistry()
    vi.mocked(fetchToolsStdio).mockResolvedValue([makeRawTool()])
    await reg.start([server])
    await reg.startStdioInteractiveAuth(server.id)

    resolveTools?.([makeRawTool({ name: 'interactive_tool' })])
    await Promise.resolve()
    await Promise.resolve()

    const cached = await reg.getTools(server.id)
    expect(cached).toEqual([
      expect.objectContaining({
        name: 'interactive_tool',
        serverId: server.id,
      }),
    ])
    expect(reg.getStdioInteractiveAuthState(server.id).status).toBe(StdioInteractiveAuthStatus.Ready)
  })

  it('rejects interactive stdio auth when the server is not opted in', async () => {
    const server = makeServer({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'fake-server'],
      url: undefined,
    })

    const reg = new DownstreamRegistry()
    vi.mocked(fetchToolsStdio).mockResolvedValue([makeRawTool()])
    await reg.start([server])

    await expect(reg.startStdioInteractiveAuth(server.id)).rejects.toThrow(
      'Interactive authentication is not enabled',
    )
  })
})

describe('DownstreamRegistry.refreshAll()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('errors from one server do not prevent others from refreshing', async () => {
    const serverA = makeServer({ id: 'server-a', url: 'http://a.example' })
    const serverB = makeServer({ id: 'server-b', url: 'http://b.example' })

    const reg = new DownstreamRegistry()
    vi.mocked(fetchToolsHttp).mockResolvedValue([makeRawTool()])
    await reg.start([serverA, serverB])

    let callCount = 0
    vi.spyOn(reg, 'refreshTools').mockImplementation(async (id) => {
      callCount++
      if (id === 'server-a') throw new Error('server-a is down')
      return [normalizeToolRecord(makeRawTool(), serverB)]
    })

    await expect(reg.refreshAll()).resolves.toBeUndefined()
    expect(callCount).toBe(2)
  })

  it('logs errors for failing servers without propagating', async () => {
    const server = makeServer()
    const reg = new DownstreamRegistry()

    vi.mocked(fetchToolsHttp).mockResolvedValue([makeRawTool()])
    await reg.start([server])

    vi.spyOn(reg, 'refreshTools').mockRejectedValue(new Error('transport failure'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await reg.refreshAll()

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('test-server'),
      expect.any(Error),
    )
    consoleSpy.mockRestore()
  })
})

describe('DownstreamRegistry.start() and stop()', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('populates server map after start', async () => {
    const server = makeServer()
    const reg = new DownstreamRegistry()
    vi.mocked(fetchToolsHttp).mockResolvedValue([makeRawTool()])

    await reg.start([server])

    const found = await reg.getServer('test-server')
    expect(found).toEqual(server)
  })

  it('refreshes stdio servers during start', async () => {
    const server = makeServer({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'fake-server'],
      url: undefined,
    })
    const reg = new DownstreamRegistry()
    vi.mocked(fetchToolsStdio).mockResolvedValue([makeRawTool()])

    await reg.start([server])

    expect(fetchToolsStdio).toHaveBeenCalledWith(server)
  })

  it('still auto-refreshes HTTP servers during start', async () => {
    const server = makeServer()
    vi.mocked(fetchToolsHttp).mockResolvedValue([makeRawTool()])
    const reg = new DownstreamRegistry()

    await reg.start([server])

    expect(fetchToolsHttp).toHaveBeenCalledWith(server, undefined)
  })

  it('listServers returns all registered servers', async () => {
    const s1 = makeServer({ id: 's1', url: 'http://s1' })
    const s2 = makeServer({ id: 's2', url: 'http://s2' })
    const reg = new DownstreamRegistry()
    vi.mocked(fetchToolsHttp).mockResolvedValue([makeRawTool()])

    await reg.start([s1, s2])

    const servers = await reg.listServers()
    expect(servers).toHaveLength(2)
    expect(servers.map((s) => s.id)).toContain('s1')
    expect(servers.map((s) => s.id)).toContain('s2')
  })

  it('stop() clears periodic refresh timers', async () => {
    vi.useFakeTimers()
    const server = makeServer({ refreshIntervalSeconds: 60 })
    const reg = new DownstreamRegistry()
    vi.mocked(fetchToolsHttp).mockResolvedValue([makeRawTool()])

    await reg.start([server])
    reg.stop()

    const refreshSpy = vi.spyOn(reg, 'refreshTools')
    vi.advanceTimersByTime(120_000)
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('starts 300s periodic refresh when discovery.mode is auto and interval is unset', async () => {
    vi.useFakeTimers()
    const server = makeServer({
      refreshIntervalSeconds: undefined,
      discovery: { mode: 'auto' },
    })
    const reg = new DownstreamRegistry()
    vi.mocked(fetchToolsHttp).mockResolvedValue([makeRawTool()])
    const refreshSpy = vi.spyOn(reg, 'refreshTools')

    await reg.start([server])
    refreshSpy.mockClear()

    vi.advanceTimersByTime(300_000)
    expect(refreshSpy).toHaveBeenCalledWith('test-server')

    reg.stop()
  })

  it('does not start periodic refresh when discovery is manual and interval is unset', async () => {
    vi.useFakeTimers()
    const server = makeServer({
      refreshIntervalSeconds: undefined,
      discovery: { mode: 'manual' },
    })
    const reg = new DownstreamRegistry()
    vi.mocked(fetchToolsHttp).mockResolvedValue([makeRawTool()])
    const refreshSpy = vi.spyOn(reg, 'refreshTools')

    await reg.start([server])
    refreshSpy.mockClear()

    vi.advanceTimersByTime(600_000)
    expect(refreshSpy).not.toHaveBeenCalled()

    reg.stop()
  })
})
