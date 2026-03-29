import { describe, expect, it, vi } from 'vitest'
import { McpRuntimeApi } from '../../../src/runtime/mcp-api.js'
import { HandleRegistry } from '../../../src/runtime/handle-registry.js'

function makeRegistry(): HandleRegistry {
  const registry = new HandleRegistry()
  registry.register({ serverId: 's1', name: 'toolA', namespace: 'ns1' })
  registry.register({ serverId: 's2', name: 'toolB', namespace: 'ns1' })
  registry.register({ serverId: 's3', name: 'toolC', namespace: 'ns1' })
  registry.register({ serverId: 's1', name: 'toolD', namespace: 'ns1' })
  registry.register({ serverId: 's2', name: 'toolE', namespace: 'ns1' })
  return registry
}

describe('McpRuntimeApi.batch() parallel execution', () => {
  it('executes all calls in parallel, not sequentially', async () => {
    const start = Date.now()

    const executeTool = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30))
      return 'ok'
    })

    const registry = makeRegistry()
    const handles = registry.entries()
    const api = new McpRuntimeApi(registry, executeTool, 10, 5)

    await api.batch([
      { handle: handles[0].handle },
      { handle: handles[1].handle },
      { handle: handles[2].handle },
    ])

    const elapsed = Date.now() - start
    expect(executeTool).toHaveBeenCalledTimes(3)
    // Parallel: ~30ms, Sequential: ~90ms
    expect(elapsed).toBeLessThan(60)
  })

  it('respects maxConcurrentCalls limit', async () => {
    let concurrentCount = 0
    let maxConcurrent = 0

    const executeTool = vi.fn(async () => {
      concurrentCount++
      maxConcurrent = Math.max(maxConcurrent, concurrentCount)
      await new Promise((r) => setTimeout(r, 20))
      concurrentCount--
      return 'ok'
    })

    const registry = makeRegistry()
    const handles = registry.entries()
    const api = new McpRuntimeApi(registry, executeTool, 10, 2)

    await api.batch([
      { handle: handles[0].handle },
      { handle: handles[1].handle },
      { handle: handles[2].handle },
      { handle: handles[3].handle },
    ])

    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('returns results in original order', async () => {
    const executeTool = vi.fn(async ({ name }: { name: string }) => {
      const delay = name === 'toolA' ? 40 : name === 'toolB' ? 10 : 20
      await new Promise((r) => setTimeout(r, delay))
      return `result-${name}`
    })

    const registry = makeRegistry()
    const handles = registry.entries()
    const api = new McpRuntimeApi(registry, executeTool, 10, 5)

    const result = await api.batch([
      { handle: handles[0].handle },
      { handle: handles[1].handle },
      { handle: handles[2].handle },
    ])

    expect(result).toEqual(['result-toolA', 'result-toolB', 'result-toolC'])
  })

  it('handles errors in parallel execution', async () => {
    const executeTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'toolB') {
        throw new Error('toolB failed')
      }
      return `result-${name}`
    })

    const registry = makeRegistry()
    const handles = registry.entries()
    const api = new McpRuntimeApi(registry, executeTool, 10, 5)

    await expect(
      api.batch([
        { handle: handles[0].handle },
        { handle: handles[1].handle },
        { handle: handles[2].handle },
      ])
    ).rejects.toThrow('toolB failed')
  })

  it('throws when tool call limit exceeded', async () => {
    const executeTool = vi.fn()

    const registry = makeRegistry()
    const handles = registry.entries()
    const api = new McpRuntimeApi(registry, executeTool, 2, 5)

    await expect(
      api.batch([
        { handle: handles[0].handle },
        { handle: handles[1].handle },
        { handle: handles[2].handle },
      ])
    ).rejects.toThrow('Tool call limit exceeded (2)')
  })

  it('allows batch size equal to maxToolCallsPerExecution (one increment per call)', async () => {
    const executeTool = vi.fn(async () => 'ok')

    const registry = makeRegistry()
    const handles = registry.entries()
    const api = new McpRuntimeApi(registry, executeTool, 2, 5)

    const result = await api.batch([
      { handle: handles[0].handle },
      { handle: handles[1].handle },
    ])

    expect(result).toEqual(['ok', 'ok'])
    expect(executeTool).toHaveBeenCalledTimes(2)
  })

  it('returns empty array for empty calls', async () => {
    const executeTool = vi.fn()

    const registry = makeRegistry()
    const api = new McpRuntimeApi(registry, executeTool, 10, 5)

    const result = await api.batch([])

    expect(result).toEqual([])
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('accepts a catalog result object directly in mcp.call()', async () => {
    const executeTool = vi.fn(async ({ name }: { name: string }) => `result-${name}`)

    const registry = makeRegistry()
    const handles = registry.entries()
    const api = new McpRuntimeApi(registry, executeTool, 10, 5)

    const result = await api.call({ handle: handles[0]!.handle }, { query: 'docs' })

    expect(result).toBe('result-toolA')
    expect(executeTool).toHaveBeenCalledWith({
      serverId: 's1',
      name: 'toolA',
      args: { query: 'docs' },
    })
  })

  it('searches and executes the best match with callMatch()', async () => {
    const executeTool = vi.fn(async ({ name }: { name: string }) => `result-${name}`)

    const registry = makeRegistry()
    const api = new McpRuntimeApi(
      registry,
      executeTool,
      10,
      5,
      () => ({ handle: registry.entries()[1]!.handle, name: 'toolB' })
    )

    const result = await api.callMatch('tool b', { query: 'docs' })

    expect(result).toBe('result-toolB')
    expect(executeTool).toHaveBeenCalledWith({
      serverId: 's2',
      name: 'toolB',
      args: { query: 'docs' },
    })
  })
})
