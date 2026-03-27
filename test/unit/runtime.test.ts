import { describe, expect, it, vi, beforeEach } from 'vitest'
import { setConfig } from '../../src/config/index.js'
import { executeCodeMode } from '../../src/runtime/index.js'
import { HandleRegistry } from '../../src/runtime/handle-registry.js'
import { GatewayMode, Mode, SessionStatus, ToolRiskLevel } from '../../src/types/enums.js'
import { SessionIdSchema } from '../../src/types/identity.js'
import type { SessionState } from '../../src/types/session.js'
import type { ToolRecord } from '../../src/types/tools.js'
import type { DownstreamServer } from '../../src/types/server.js'
import {
  defaultDebug,
  defaultResilience,
  defaultSelector,
  defaultSession,
  defaultTriggers,
} from '../fixtures/bootstrap-json.js'

function makeSession(): SessionState {
  const now = new Date().toISOString()
  return {
    id: SessionIdSchema.parse('session-runtime'),
    userId: 'user-runtime',
    namespace: 'github',
    mode: Mode.Read,
    status: SessionStatus.Active,
    toolWindow: [],
    createdAt: now,
    lastActiveAt: now,
    refreshCount: 0,
    recentOutcomes: [],
    refreshHistory: [],
    pendingToolListChange: false,
    resolvedPolicy: {
      namespacePolicy: {
        gatewayMode: GatewayMode.Code,
        candidatePoolSize: 16,
      },
    },
  }
}

function makeServer(id: string): DownstreamServer {
  return {
    id,
    namespaces: ['github'],
    transport: 'http',
    url: 'https://example.com/mcp',
    enabled: true,
    trustLevel: 'internal',
  }
}

function makeToolRecord(name: string, description: string, serverId = 'github-main'): ToolRecord {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        prNumber: { type: 'number' },
      },
      required: ['owner', 'repo'],
    },
    serverId,
    namespace: 'github',
    retrievedAt: new Date().toISOString(),
    sanitized: true,
  }
}

beforeEach(() => {
  setConfig({
    servers: [],
    auth: { mode: 'static_key' },
    namespaces: {
      github: {
        allowedRoles: ['developer'],
        bootstrapWindowSize: 4,
        candidatePoolSize: 16,
        allowedModes: [Mode.Read, Mode.Write],
        gatewayMode: GatewayMode.Code,
        disabledTools: [],
      },
    },
    roles: {
      developer: {
        allowNamespaces: ['github'],
      },
    },
    selector: defaultSelector,
    session: defaultSession,
    triggers: defaultTriggers,
    resilience: defaultResilience,
    debug: defaultDebug,
    codeMode: {
      memoryLimitMb: 128,
      executionTimeoutMs: 5_000,
      maxToolCallsPerExecution: 10,
      maxResultSizeBytes: 8_192,
      artifactStoreTtlSeconds: 300,
      maxConcurrentToolCalls: 5,
    },
    starterPacks: {},
  })
})

describe('HandleRegistry', () => {
  it('reuses the same handle for the same tool target', () => {
    const registry = new HandleRegistry()
    const first = registry.register({ serverId: 'github', namespace: 'github', name: 'list_prs' })
    const second = registry.register({ serverId: 'github', namespace: 'github', name: 'list_prs' })

    expect(first).toBe('h_1')
    expect(second).toBe(first)
    expect(registry.resolve(first)).toEqual({
      serverId: 'github',
      namespace: 'github',
      name: 'list_prs',
    })
  })
})

describe('executeCodeMode', () => {
  it('runs discovery, tool execution, and projection inside one runtime call', async () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('github-main'),
          records: [
            makeToolRecord('list_open_pull_requests', 'List open pull requests for a repository'),
          ],
        },
      ]),
    }
    const executeTool = vi.fn().mockResolvedValue([
      {
        number: 42,
        title: 'Fix flaky benchmark',
        state: 'open',
        body: 'Long body that should not be returned',
      },
      {
        number: 43,
        title: 'Refactor selector',
        state: 'closed',
        body: 'Another long body',
      },
    ])

    const result = (await executeCodeMode(
      `
      const tools = await catalog.search("open pull requests", { k: 1, detail: "summary" })
      const rows = await mcp.call(tools[0].handle, { owner: "acme", repo: "gateway" })
      return result.limit(result.pick(rows, ["number", "title", "state"]), 1)
      `,
      session,
      registry as never,
      {
        memoryLimitMb: 128,
        executionTimeoutMs: 5_000,
        maxToolCallsPerExecution: 10,
        maxResultSizeBytes: 8_192,
        artifactStoreTtlSeconds: 300,
        maxConcurrentToolCalls: 5,
      },
      executeTool
    )) as { backend: string; value: Array<Record<string, unknown>> }

    expect(result.backend).toBe('isolated-vm')
    expect(result.value).toEqual([
      {
        number: 42,
        title: 'Fix flaky benchmark',
        state: 'open',
      },
    ])
    expect(executeTool).toHaveBeenCalledWith({
      serverId: 'github-main',
      name: 'list_open_pull_requests',
      args: { owner: 'acme', repo: 'gateway' },
    })
  })

  it('accepts limit as a compatibility alias for catalog.search', async () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('github-main'),
          records: [
            makeToolRecord('search_docs', 'Search documentation'),
            makeToolRecord('search_issues', 'Search issues'),
            makeToolRecord('search_code', 'Search code'),
          ],
        },
      ]),
    }

    const result = (await executeCodeMode(
      `
      return await catalog.search("search", { limit: 2, detail: "summary" })
      `,
      session,
      registry as never,
      {
        memoryLimitMb: 128,
        executionTimeoutMs: 5_000,
        maxToolCallsPerExecution: 10,
        maxResultSizeBytes: 8_192,
        artifactStoreTtlSeconds: 300,
        maxConcurrentToolCalls: 5,
      },
      vi.fn()
    )) as { value: Array<{ name: string; summary: string; risk: string }> }

    expect(result.value).toHaveLength(2)
    expect(result.value[0]).toHaveProperty('summary')
    expect(result.value[0]).toHaveProperty('risk')
    expect(result.value[0]).not.toHaveProperty('description')
  })

  it('prefers k over limit when both are provided to catalog.search', async () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('github-main'),
          records: [
            makeToolRecord('search_docs', 'Search documentation'),
            makeToolRecord('search_issues', 'Search issues'),
            makeToolRecord('search_code', 'Search code'),
          ],
        },
      ]),
    }

    const result = (await executeCodeMode(
      `
      return await catalog.search("search", { k: 1, limit: 3, detail: "summary" })
      `,
      session,
      registry as never,
      {
        memoryLimitMb: 128,
        executionTimeoutMs: 5_000,
        maxToolCallsPerExecution: 10,
        maxResultSizeBytes: 8_192,
        artifactStoreTtlSeconds: 300,
        maxConcurrentToolCalls: 5,
      },
      vi.fn()
    )) as { value: Array<{ name: string }> }

    expect(result.value).toHaveLength(1)
  })

  it('returns an actionable error when result.limit receives a non-array', async () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('docs-main'),
          records: [makeToolRecord('search_docs', 'Search documentation', 'docs-main')],
        },
      ]),
    }
    const executeTool = vi.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    })

    await expect(
      executeCodeMode(
        `
        const tools = await catalog.search("documentation", { k: 1 })
        const out = await mcp.call(tools[0].handle, { query: "quickstart" })
        return result.limit(out, 1)
        `,
        session,
        registry as never,
        {
          memoryLimitMb: 128,
          executionTimeoutMs: 5_000,
          maxToolCallsPerExecution: 10,
          maxResultSizeBytes: 8_192,
          artifactStoreTtlSeconds: 300,
          maxConcurrentToolCalls: 5,
        },
        executeTool
      )
    ).rejects.toThrow(
      'result.limit expects an array; pass an array value such as out.content instead of the whole object.'
    )
  })

  it('exposes result.items and result.text for tool outputs with content blocks', async () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('docs-main'),
          records: [makeToolRecord('search_docs', 'Search documentation', 'docs-main')],
        },
      ]),
    }
    const executeTool = vi.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'first block' },
        { type: 'text', text: 'second block' },
      ],
    })

    const result = (await executeCodeMode(
      `
      const tools = await catalog.search("documentation", { k: 1, detail: "signature" })
      const out = await mcp.call(tools[0].handle, { query: "quickstart" })
      return {
        first: result.limit(result.items(out), 1),
        text: result.text(out)
      }
      `,
      session,
      registry as never,
      {
        memoryLimitMb: 128,
        executionTimeoutMs: 5_000,
        maxToolCallsPerExecution: 10,
        maxResultSizeBytes: 8_192,
        artifactStoreTtlSeconds: 300,
        maxConcurrentToolCalls: 5,
      },
      executeTool
    )) as { value: { first: Array<Record<string, unknown>>; text: string } }

    expect(result.value).toEqual({
      first: [{ type: 'text', text: 'first block' }],
      text: 'first block\nsecond block',
    })
  })

  it('returns an actionable error when a script indexes a missing tool entry', async () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('fastmcp'),
          records: [makeToolRecord('search_fast_mcp', 'Search FastMCP docs', 'fastmcp')],
        },
      ]),
    }

    await expect(
      executeCodeMode(
        `
        const tools = await catalog.search("fastmcp docs", {
          serverId: "fastmcp",
          requiredArgs: ["owner", "repo"],
          detail: "signature",
          k: 5,
        })
        return tools[1].handle
        `,
        session,
        registry as never,
        {
          memoryLimitMb: 128,
          executionTimeoutMs: 5_000,
          maxToolCallsPerExecution: 10,
          maxResultSizeBytes: 8_192,
          artifactStoreTtlSeconds: 300,
          maxConcurrentToolCalls: 5,
        },
        vi.fn()
      )
    ).rejects.toThrow(
      'The script tried to use a missing tool entry (for example tools[1].handle). Check tools.length first, increase k, or relax the search filters before building the call or batch.'
    )
  })

  it('does not expose process globals inside the sandbox', async () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([]),
    }

    const result = (await executeCodeMode(
      'return typeof process',
      session,
      registry as never,
      {
        memoryLimitMb: 128,
        executionTimeoutMs: 5_000,
        maxToolCallsPerExecution: 10,
        maxResultSizeBytes: 8_192,
        artifactStoreTtlSeconds: 300,
        maxConcurrentToolCalls: 5,
      },
      vi.fn()
    )) as { value: string }

    expect(result.value).toBe('undefined')
  })

  it('stores oversized final results as artifacts automatically', async () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([]),
    }

    const result = (await executeCodeMode(
      'return Array.from({ length: 25 }, (_, index) => ({ index, text: "x".repeat(120) }))',
      session,
      registry as never,
      {
        memoryLimitMb: 128,
        executionTimeoutMs: 5_000,
        maxToolCallsPerExecution: 10,
        maxResultSizeBytes: 256,
        artifactStoreTtlSeconds: 300,
        maxConcurrentToolCalls: 5,
      },
      vi.fn()
    )) as {
      backend: string
      artifactRef: string
      byteSize: number
      preview: { type: string }
    }

    expect(result.backend).toBe('isolated-vm')
    expect(result.artifactRef).toMatch(/^artifact_/)
    expect(result.byteSize).toBeGreaterThan(256)
    expect(result.preview.type).toBe('object')
  })

  it('normalizes complex downstream values so code mode can return serializable data', async () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('github-main'),
          records: [makeToolRecord('inspect_runtime_shape', 'Return a complex runtime shape')],
        },
      ]),
    }
    const executeTool = vi.fn().mockResolvedValue({
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      tags: new Set(['alpha', 'beta']),
      meta: new Map([['count', 3n]]),
    })

    const result = (await executeCodeMode(
      `
      const tools = await catalog.search("runtime shape", { k: 1 })
      return await mcp.call(tools[0].handle, {})
      `,
      session,
      registry as never,
      {
        memoryLimitMb: 128,
        executionTimeoutMs: 5_000,
        maxToolCallsPerExecution: 10,
        maxResultSizeBytes: 8_192,
        artifactStoreTtlSeconds: 300,
        maxConcurrentToolCalls: 5,
      },
      executeTool
    )) as {
      backend: string
      value: { createdAt: string; tags: string[]; meta: { count: string } }
    }

    expect(result.backend).toBe('isolated-vm')
    expect(result.value).toEqual({
      createdAt: '2026-01-02T03:04:05.000Z',
      tags: ['alpha', 'beta'],
      meta: { count: '3' },
    })
  })

  it('supports mcp.batch across multiple discovered handles', async () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('github-main'),
          records: [
            makeToolRecord('list_open_pull_requests', 'List open pull requests'),
            makeToolRecord('list_closed_pull_requests', 'List closed pull requests'),
          ],
        },
      ]),
    }
    const executeTool = vi.fn().mockImplementation(async ({ name }) => ({ tool: name }))

    const result = (await executeCodeMode(
      `
      const tools = await catalog.list({ limit: 2, detail: "name" })
      return await mcp.batch([
        { handle: tools[0].handle, args: { owner: "acme", repo: "gateway" } },
        { handle: tools[1].handle, args: { owner: "acme", repo: "gateway" } },
      ])
      `,
      session,
      registry as never,
      {
        memoryLimitMb: 128,
        executionTimeoutMs: 5_000,
        maxToolCallsPerExecution: 10,
        maxResultSizeBytes: 8_192,
        artifactStoreTtlSeconds: 300,
        maxConcurrentToolCalls: 5,
      },
      executeTool
    )) as { value: Array<{ tool: string }> }

    expect(result.value).toEqual([
      { tool: 'list_open_pull_requests' },
      { tool: 'list_closed_pull_requests' },
    ])
  })

  it('supports artifacts.save and artifacts.list from code mode', async () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([]),
    }

    const result = (await executeCodeMode(
      `
      const saved = await artifacts.save({ ok: true }, { label: "runtime-test" })
      const items = await artifacts.list()
      return { saved, count: result.count(items) }
      `,
      session,
      registry as never,
      {
        memoryLimitMb: 128,
        executionTimeoutMs: 5_000,
        maxToolCallsPerExecution: 10,
        maxResultSizeBytes: 8_192,
        artifactStoreTtlSeconds: 300,
        maxConcurrentToolCalls: 5,
      },
      vi.fn()
    )) as { value: { saved: { ref: string }; count: number } }

    expect(result.value.saved.ref).toMatch(/^artifact_/)
    expect(result.value.count).toBeGreaterThanOrEqual(1)
  })

})

import { RuntimeConfigManager } from '../../src/config/runtime.js'
import type { GatewayConfig } from '../../src/config/loader.js'

function makeConfig(): GatewayConfig {
  return {
    servers: [],
    auth: { mode: 'static_key' },
    namespaces: {},
    roles: {},
    selector: defaultSelector,
    session: defaultSession,
    triggers: defaultTriggers,
    resilience: defaultResilience,
    debug: defaultDebug,
    codeMode: {
      memoryLimitMb: 128,
      executionTimeoutMs: 5_000,
      maxToolCallsPerExecution: 10,
      maxResultSizeBytes: 8_192,
      artifactStoreTtlSeconds: 300,
      maxConcurrentToolCalls: 5,
    },
    starterPacks: {},
  }
}

describe('RuntimeConfigManager.initialize()', () => {
  it('starts the registry when running without a config repository', async () => {
    const config = makeConfig()
    const registry = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    }

    const manager = new RuntimeConfigManager({
      bootstrap: { auth: config.auth },
      initial: config,
      registry: registry as any,
    })

    await manager.initialize()

    expect(registry.start).toHaveBeenCalledTimes(1)
    expect(registry.start).toHaveBeenCalledWith(config.servers, config.resilience)
  })

  it('starts the registry once after seeding the initial persisted config', async () => {
    const config = makeConfig()
    const registry = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    }
    const configRepo = {
      getActive: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(1),
    }

    const manager = new RuntimeConfigManager({
      bootstrap: { auth: config.auth },
      initial: config,
      registry: registry as any,
      configRepo: configRepo as any,
    })

    await manager.initialize()

    expect(configRepo.save).toHaveBeenCalledTimes(1)
    expect(registry.start).toHaveBeenCalledTimes(1)
    expect(registry.start).toHaveBeenCalledWith(config.servers, config.resilience)
  })
})

describe('RuntimeConfigManager.saveAdminConfig()', () => {
  it('re-registers downstream servers in the runtime registry after admin edits', async () => {
    const config = makeConfig()
    const registry = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    }
    const configRepo = {
      save: vi.fn().mockResolvedValue(1),
    }

    const manager = new RuntimeConfigManager({
      bootstrap: { auth: config.auth },
      initial: config,
      registry: registry as any,
      configRepo: configRepo as any,
    })

    const version = await manager.saveAdminConfig(
      {
        ...manager.getAdminConfig(),
        servers: [
          {
            id: 'docs',
            namespaces: ['default'],
            transport: 'streamable-http',
            url: 'https://example.com/mcp',
            enabled: true,
            trustLevel: 'verified',
          },
        ] as any,
      },
      {
        source: 'ui_edit',
        createdBy: 'test',
        comment: 'Add docs server',
      }
    )

    expect(version).toBe(1)
    expect(configRepo.save).toHaveBeenCalledTimes(1)
    expect(registry.stop).toHaveBeenCalledTimes(1)
    expect(registry.start).toHaveBeenCalledTimes(1)
    expect(registry.start).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'docs',
          url: 'https://example.com/mcp',
        }),
      ]),
      config.resilience
    )
    expect(manager.getEffective().servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'docs',
          url: 'https://example.com/mcp',
        }),
      ])
    )
  })
})
