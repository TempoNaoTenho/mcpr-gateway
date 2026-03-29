import { beforeEach, describe, expect, it } from 'vitest'
import { setConfig } from '../../src/config/index.js'
import { CatalogRuntimeApi } from '../../src/runtime/catalog-api.js'
import { HandleRegistry } from '../../src/runtime/handle-registry.js'
import { GatewayMode, Mode, SessionStatus } from '../../src/types/enums.js'
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
    id: SessionIdSchema.parse('session-catalog-runtime'),
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
        query: { type: 'string' },
      },
      required: ['query'],
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

describe('CatalogRuntimeApi', () => {
  it('lists unique server IDs in sorted order', () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: () => [
        {
          server: makeServer('fastmcp'),
          records: [makeToolRecord('search_fast_mcp', 'Search FastMCP docs', 'fastmcp')],
        },
        {
          server: makeServer('context7'),
          records: [makeToolRecord('query-docs', 'Query docs', 'context7')],
        },
        {
          server: makeServer('fastmcp'),
          records: [makeToolRecord('read_fastmcp_doc', 'Read FastMCP docs', 'fastmcp')],
        },
      ],
    }

    const api = new CatalogRuntimeApi(session, registry as never, new HandleRegistry())
    expect(api.servers()).toEqual([{ serverId: 'context7' }, { serverId: 'fastmcp' }])
  })

  it('accepts limit as a compatibility alias for search', () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: () => [
        {
          server: makeServer('github-main'),
          records: [
            makeToolRecord('search_docs', 'Search documentation'),
            makeToolRecord('search_issues', 'Search issues'),
            makeToolRecord('search_code', 'Search code'),
          ],
        },
      ],
    }

    const api = new CatalogRuntimeApi(session, registry as never, new HandleRegistry())
    const results = api.search('search', { limit: 2, detail: 'summary' }) as Array<
      Record<string, unknown>
    >

    expect(results).toHaveLength(2)
    expect(results[0]).toHaveProperty('summary')
    expect(results[0]).toHaveProperty('risk')
    expect(results[0]).not.toHaveProperty('description')
  })

  it('prefers k over limit when both are provided', () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: () => [
        {
          server: makeServer('github-main'),
          records: [
            makeToolRecord('search_docs', 'Search documentation'),
            makeToolRecord('search_issues', 'Search issues'),
            makeToolRecord('search_code', 'Search code'),
          ],
        },
      ],
    }

    const api = new CatalogRuntimeApi(session, registry as never, new HandleRegistry())
    const results = api.search('search', { k: 1, limit: 3, detail: 'summary' }) as Array<
      Record<string, unknown>
    >

    expect(results).toHaveLength(1)
  })

  it('exposes description only in full detail', () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: () => [
        {
          server: makeServer('github-main'),
          records: [makeToolRecord('search_docs', 'Search documentation')],
        },
      ],
    }

    const api = new CatalogRuntimeApi(session, registry as never, new HandleRegistry())
    const summary = api.search('search', { k: 1, detail: 'summary' }) as Array<Record<string, unknown>>
    const full = api.search('search', { k: 1, detail: 'full' }) as Array<Record<string, unknown>>

    expect(summary[0]).toHaveProperty('summary')
    expect(summary[0]).not.toHaveProperty('description')
    expect(full[0]).toHaveProperty('description', 'Search documentation')
  })

  it('returns the best match from searchOne', () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: () => [
        {
          server: makeServer('github-main'),
          records: [
            makeToolRecord('search_docs', 'Search documentation'),
            makeToolRecord('search_issues', 'Search issues'),
          ],
        },
      ],
    }

    const api = new CatalogRuntimeApi(session, registry as never, new HandleRegistry())
    const result = api.searchOne('documentation', { detail: 'summary' }) as Record<string, unknown>

    expect(result.name).toBe('search_docs')
    expect(result).toHaveProperty('handle')
  })

  it('filters search results by serverId and requiredArgs', () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: () => [
        {
          server: makeServer('fastmcp'),
          records: [
            makeToolRecord('search_fast_mcp', 'Search FastMCP docs', 'fastmcp'),
            makeToolRecord('resolve-library-id', 'Resolve Context7 library ids', 'fastmcp'),
          ],
        },
        {
          server: makeServer('context7'),
          records: [makeToolRecord('query-docs', 'Query docs', 'context7')],
        },
      ],
    }

    const api = new CatalogRuntimeApi(session, registry as never, new HandleRegistry())
    const results = api.search('docs', {
      serverId: 'fastmcp',
      requiredArgs: ['query'],
      detail: 'signature',
      k: 5,
    }) as Array<Record<string, unknown>>

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      name: 'search_fast_mcp',
      args: ['query'],
      required: ['query'],
      properties: {
        query: {
          type: 'string',
        },
      },
    })
  })

  it('filters list results by serverId and requiredArgs', () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: () => [
        {
          server: makeServer('fastmcp'),
          records: [
            makeToolRecord('search_fast_mcp', 'Search FastMCP docs', 'fastmcp'),
            {
              ...makeToolRecord('calculator', 'Calculate values', 'fastmcp'),
              inputSchema: {
                type: 'object',
                properties: {
                  operation: { type: 'string' },
                  a: { type: 'number' },
                  b: { type: 'number' },
                },
                required: ['operation', 'a', 'b'],
              },
            },
          ],
        },
      ],
    }

    const api = new CatalogRuntimeApi(session, registry as never, new HandleRegistry())
    const results = api.list({
      serverId: 'fastmcp',
      requiredArgs: ['query'],
      detail: 'signature',
      limit: 10,
    }) as Array<Record<string, unknown>>

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      name: 'search_fast_mcp',
      args: ['query'],
      required: ['query'],
      properties: {
        query: {
          type: 'string',
        },
      },
    })
  })

  it('exposes a short signature shape from catalog.describe', () => {
    const session = makeSession()
    const registry = {
      getToolsByNamespace: () => [
        {
          server: makeServer('context7'),
          records: [
            {
              ...makeToolRecord('query-docs', 'Query docs', 'context7'),
              inputSchema: {
                type: 'object',
                properties: {
                  libraryId: {
                    type: 'string',
                    description: 'Context7-compatible library ID',
                  },
                  query: {
                    type: 'string',
                    description: 'Query to send to Context7',
                  },
                  format: {
                    type: 'string',
                    enum: ['markdown', 'text'],
                  },
                },
                required: ['libraryId', 'query'],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    }

    const api = new CatalogRuntimeApi(session, registry as never, new HandleRegistry())
    const [tool] = api.search('query docs', { k: 1, detail: 'signature' }) as Array<
      Record<string, unknown>
    >
    const details = api.describe(tool.handle as string, { detail: 'signature' }) as Record<string, unknown>

    expect(details).toMatchObject({
      name: 'query-docs',
      args: ['libraryId', 'query'],
      required: ['libraryId', 'query'],
      properties: {
        libraryId: {
          type: 'string',
          description: 'Context7-compatible library ID',
        },
        query: {
          type: 'string',
          description: 'Query to send to Context7',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'text'],
        },
      },
      acceptsAdditionalProperties: false,
    })
  })
})
