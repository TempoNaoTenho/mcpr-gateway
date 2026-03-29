import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyRequest } from 'fastify'
import { handleInitialize } from '../../src/gateway/dispatch/initialize.js'
import type { McpHandlerContext } from '../../src/gateway/mcp-handler-context.js'
import { getConfig, initConfig, setConfig } from '../../src/config/index.js'
import {
  defaultDebug,
  defaultResilience,
  defaultSelector,
  defaultSession,
  defaultTestStaticKeys,
  defaultTriggers,
} from '../fixtures/bootstrap-json.js'
import { createTempSqliteSessionStore } from '../fixtures/sqlite-session-store.js'
import { DownstreamHealth, GatewayMode, Mode } from '../../src/types/enums.js'
import type { ToolRecord } from '../../src/types/tools.js'
import type { DownstreamServer } from '../../src/types/server.js'
import {
  GATEWAY_SEARCH_TOOL_NAME,
  GATEWAY_CALL_TOOL_NAME,
  GATEWAY_LIST_SERVERS_TOOL_NAME,
  GATEWAY_RUN_CODE_TOOL_NAME,
  GATEWAY_HELP_TOOL_NAME,
} from '../../src/gateway/discovery.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, '__tmp_initialize_config__')

const AUTH_USER = 'Bearer alice:user'

function makeRequest(mode?: Mode): FastifyRequest {
  return {
    headers: { authorization: AUTH_USER },
    params: { namespace: 'gmail' },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: mode ? { mode } : {},
    },
  } as unknown as FastifyRequest
}

function makeHandlerContext(mode?: Mode): McpHandlerContext {
  const request = makeRequest(mode)
  return {
    namespace: (request.params as { namespace: string }).namespace,
    authorization: request.headers.authorization as string | undefined,
    requestId: 'test-req',
    log: undefined,
  }
}

function makeServer(overrides: Partial<DownstreamServer> = {}): DownstreamServer {
  return {
    id: 'gmail-server',
    namespaces: ['gmail'],
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
    enabled: true,
    trustLevel: 'internal',
    ...overrides,
  }
}

function makeToolRecord(name: string, description?: string, serverId = 'gmail-server'): ToolRecord {
  return {
    name,
    description: description ?? `Description for ${name}`,
    inputSchema: {},
    serverId,
    namespace: 'gmail',
    retrievedAt: new Date().toISOString(),
    sanitized: true,
  }
}

function makeRegistry(records: ToolRecord[], serverOverrides: Partial<DownstreamServer> = {}) {
  const server = makeServer({ ...serverOverrides })
  return {
    getToolsByNamespace(namespace: string) {
      if (namespace !== 'gmail') return []
      return [{ server, records }]
    },
    getHealthStates() {
      return {}
    },
  }
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(
    join(TMP, 'bootstrap.json'),
    JSON.stringify(
      {
        servers: [
          {
            id: 'gmail-server',
            namespaces: ['gmail'],
            transport: 'streamable-http',
            url: 'https://example.com/mcp',
            enabled: true,
            trustLevel: 'internal',
          },
        ],
        auth: { mode: 'static_key' },
        namespaces: {
          gmail: {
            allowedRoles: ['user', 'admin'],
            bootstrapWindowSize: 4,
            candidatePoolSize: 16,
            allowedModes: ['read', 'write'],
          },
        },
        roles: {
          user: {
            allowNamespaces: ['gmail'],
            denyModes: ['admin'],
          },
          admin: {
            allowNamespaces: ['gmail'],
          },
        },
        selector: defaultSelector,
        session: defaultSession,
        triggers: defaultTriggers,
        resilience: defaultResilience,
        debug: defaultDebug,
        starterPacks: {
          gmail: {
            preferredTags: ['email'],
            maxTools: 10,
            includeRiskLevels: ['low'],
            includeModes: ['read'],
          },
        },
      },
      null,
      2
    )
  )
  const config = initConfig(TMP)
  setConfig({
    ...config,
    auth: {
      ...config.auth,
      staticKeys: defaultTestStaticKeys,
    },
  })
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('handleInitialize', () => {
  let disposeStore: (() => void) | undefined
  afterEach(() => {
    disposeStore?.()
    disposeStore = undefined
  })

  it('returns an empty bootstrap window when the starter pack excludes the requested mode', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const registry = makeRegistry([
      makeToolRecord('get_threads'),
      makeToolRecord('read_message'),
      makeToolRecord('list_labels'),
    ])

    const response = await handleInitialize(
      makeHandlerContext(Mode.Write),
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { mode: Mode.Write } },
      store,
      registry as never
    )

    const session = await store.get(response.id)
    // toolWindow now contains only gateway compat tools
    expect(session?.toolWindow).toHaveLength(3)
    expect(session?.toolWindow.map((t) => t.name)).toEqual([
      GATEWAY_SEARCH_TOOL_NAME,
      GATEWAY_CALL_TOOL_NAME,
      GATEWAY_LIST_SERVERS_TOOL_NAME,
    ])
    expect(session?.lastSelectorDecision?.selected).toEqual([])
  })

  it('caps the initial tool window at bootstrapWindowSize', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const registry = makeRegistry([
      makeToolRecord('email_alpha'),
      makeToolRecord('email_beta'),
      makeToolRecord('email_gamma'),
      makeToolRecord('email_delta'),
      makeToolRecord('email_epsilon'),
      makeToolRecord('email_zeta'),
    ])

    const response = await handleInitialize(
      makeHandlerContext(Mode.Read),
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { mode: Mode.Read } },
      store,
      registry as never
    )

    const session = await store.get(response.id)
    // toolWindow now contains only gateway compat tools regardless of downstream tools
    expect(session?.toolWindow).toHaveLength(3)
    expect(session?.toolWindow.map((t) => t.name)).toEqual([
      GATEWAY_SEARCH_TOOL_NAME,
      GATEWAY_CALL_TOOL_NAME,
      GATEWAY_LIST_SERVERS_TOOL_NAME,
    ])
    // lastSelectorDecision still reflects the bootstrap window computation
    expect(session?.lastSelectorDecision?.selected).toHaveLength(4)
  })

  it('stores tools.listChanged capability from initialize params', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const registry = makeRegistry([])

    const response = await handleInitialize(
      makeHandlerContext(Mode.Read),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          mode: Mode.Read,
          capabilities: {
            tools: {
              listChanged: true,
            },
          },
        },
      },
      store,
      registry as never
    )

    const session = await store.get(response.id)
    expect(session?.clientCapabilities?.supportsToolListChanged).toBe(true)
  })

  it('stores normalized initialize intent text and uses it to bias the bootstrap window', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const registry = {
      getToolsByNamespace(namespace: string) {
        if (namespace !== 'gmail') return []
        return [
          {
            server: makeServer({ id: 'docs-hub', url: 'https://docs.example.com/mcp' }),
            records: [
              makeToolRecord(
                'resolve_library_reference',
                'Read API docs, SDK reference, product manual, and guides',
                'docs-hub'
              ),
            ],
          },
          {
            server: makeServer({ id: 'web-tools', url: 'https://web.example.com/mcp' }),
            records: [
              makeToolRecord(
                'extract_web_page',
                'Browse a website and extract page contents',
                'web-tools'
              ),
            ],
          },
        ]
      },
      getHealthStates() {
        return {}
      },
    }

    const response = await handleInitialize(
      makeHandlerContext(Mode.Read),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          mode: Mode.Read,
          goal: 'Read API docs',
          query: 'SDK reference for FastMCP',
          taskContext: 'Need product documentation',
        },
      },
      store,
      registry as never
    )

    const session = await store.get(response.id)
    expect(session?.initialIntentText).toBe(
      'Read API docs SDK reference for FastMCP Need product documentation'
    )
    // toolWindow now has only gateway compat tools; intent text is stored for future use
    expect(session?.toolWindow).toHaveLength(3)
    expect(session?.toolWindow.map((t) => t.name)).toEqual([
      GATEWAY_SEARCH_TOOL_NAME,
      GATEWAY_CALL_TOOL_NAME,
      GATEWAY_LIST_SERVERS_TOOL_NAME,
    ])
  })

  it('always includes compat gateway discovery tools', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const registry = makeRegistry([makeToolRecord('read_message')])

    const response = await handleInitialize(
      makeHandlerContext(Mode.Read),
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { mode: Mode.Read } },
      store,
      registry as never
    )

    const session = await store.get(response.id)
    const toolNames = session?.toolWindow.map((tool) => tool.name) ?? []
    expect(toolNames).toContain(GATEWAY_SEARCH_TOOL_NAME)
    expect(toolNames).toContain(GATEWAY_CALL_TOOL_NAME)
    expect(toolNames).toContain(GATEWAY_LIST_SERVERS_TOOL_NAME)
    expect(session?.toolWindow).toHaveLength(3)
  })

  it('publishes gateway_run_code and gateway_help when the namespace uses code mode', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const previousConfig = getConfig()
    try {
      setConfig({
        ...previousConfig,
        namespaces: {
          ...previousConfig.namespaces,
          gmail: {
            ...previousConfig.namespaces.gmail,
            gatewayMode: GatewayMode.Code,
          },
        },
      })
      const registry = makeRegistry([makeToolRecord('read_message')])

      const response = await handleInitialize(
        makeHandlerContext(Mode.Read),
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { mode: Mode.Read } },
        store,
        registry as never
      )

      const session = await store.get(response.id)
      expect(session?.toolWindow.map((tool) => tool.name)).toEqual([
        GATEWAY_RUN_CODE_TOOL_NAME,
        GATEWAY_HELP_TOOL_NAME,
      ])
    } finally {
      setConfig(previousConfig)
    }
  })

  it('publishes enabled downstream tools directly when the namespace uses default mode', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const previousConfig = getConfig()
    try {
      setConfig({
        ...previousConfig,
        namespaces: {
          ...previousConfig.namespaces,
          gmail: {
            ...previousConfig.namespaces.gmail,
            gatewayMode: GatewayMode.Default,
            disabledTools: [{ serverId: 'gmail-server', name: 'delete_message' }],
          },
        },
      })

      const registry = makeRegistry([
        makeToolRecord('read_message'),
        makeToolRecord('delete_message'),
      ])

      const response = await handleInitialize(
        makeHandlerContext(Mode.Read),
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { mode: Mode.Read } },
        store,
        registry as never
      )

      const session = await store.get(response.id)
      expect(session?.toolWindow.map((tool) => tool.name)).toEqual(['read_message'])
      expect(session?.toolWindow).toHaveLength(1)
      expect(session?.lastSelectorDecision?.reasoning).toBe('direct_catalog')
      expect(session?.toolWindow.map((tool) => tool.name)).not.toContain(GATEWAY_SEARCH_TOOL_NAME)
      expect(session?.toolWindow.map((tool) => tool.name)).not.toContain(GATEWAY_CALL_TOOL_NAME)
    } finally {
      setConfig(previousConfig)
    }
  })

  it('filters offline downstream tools out of the bootstrap pool', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const onlineServer = makeServer()
    const offlineServer = makeServer({ id: 'offline-server', url: 'https://offline.example/mcp' })
    const registry = {
      getToolsByNamespace(namespace: string) {
        if (namespace !== 'gmail') return []
        return [
          {
            server: offlineServer,
            records: [makeToolRecord('email_archive', undefined, 'offline-server')],
          },
          { server: onlineServer, records: [makeToolRecord('email_read')] },
        ]
      },
      getHealthStates() {
        return { 'offline-server': DownstreamHealth.Offline }
      },
    }

    const response = await handleInitialize(
      makeHandlerContext(Mode.Read),
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { mode: Mode.Read } },
      store,
      registry as never
    )

    const session = await store.get(response.id)
    // toolWindow now contains only gateway compat tools
    expect(session?.toolWindow).toHaveLength(3)
    expect(session?.toolWindow.map((t) => t.name)).toEqual([
      GATEWAY_SEARCH_TOOL_NAME,
      GATEWAY_CALL_TOOL_NAME,
      GATEWAY_LIST_SERVERS_TOOL_NAME,
    ])
    // bootstrap window (via lastSelectorDecision) should have filtered out offline tools
    const selected = session?.lastSelectorDecision?.selected ?? []
    expect(selected).toHaveLength(1)
    expect(selected[0]?.serverId).toBe('gmail-server')
  })

  it('includes compat instructions in initialize response for compat mode', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const registry = makeRegistry([makeToolRecord('read_message')])

    const response = await handleInitialize(
      makeHandlerContext(Mode.Read),
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { mode: Mode.Read } },
      store,
      registry as never
    )

    const result = (response.result as { result: { instructions?: string } }).result
    expect(result.instructions).toBeDefined()
    expect(result.instructions).toContain('gateway_search_tools')
    expect(result.instructions).toContain('gateway_call_tool')
    expect(result.instructions).toContain('gateway_list_servers')
    expect(result.instructions).toContain('exact name and serverId returned by the search result')
    expect(result.instructions).toContain('"gmail-server"')
  })

  it('omits server list from compat instructions when no servers available', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const emptyRegistry = {
      getToolsByNamespace: () => [],
      getHealthStates: () => ({}),
    }

    const response = await handleInitialize(
      makeHandlerContext(Mode.Read),
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { mode: Mode.Read } },
      store,
      emptyRegistry as never
    )

    const result = (response.result as { result: { instructions?: string } }).result
    expect(result.instructions).toBeDefined()
    expect(result.instructions).toContain('gateway_search_tools')
    expect(result.instructions).toContain('gateway_list_servers')
    expect(result.instructions).not.toContain('Available servers')
  })

  it('includes code mode instructions in initialize response for code mode', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const previousConfig = getConfig()
    try {
      setConfig({
        ...previousConfig,
        namespaces: {
          ...previousConfig.namespaces,
          gmail: {
            ...previousConfig.namespaces.gmail,
            gatewayMode: GatewayMode.Code,
          },
        },
      })
      const registry = makeRegistry([makeToolRecord('read_message')])

      const response = await handleInitialize(
        makeHandlerContext(Mode.Read),
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { mode: Mode.Read } },
        store,
        registry as never
      )

      const result = (response.result as { result: { instructions?: string } }).result
      expect(result.instructions).toBeDefined()
      expect(result.instructions).toContain('gateway_run_code')
      expect(result.instructions).toContain('catalog.servers')
      expect(result.instructions).toContain('catalog.search')
      expect(result.instructions).toContain('mcp.call')
    } finally {
      setConfig(previousConfig)
    }
  })

  it('omits instructions in initialize response for default mode', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const previousConfig = getConfig()
    try {
      setConfig({
        ...previousConfig,
        namespaces: {
          ...previousConfig.namespaces,
          gmail: {
            ...previousConfig.namespaces.gmail,
            gatewayMode: GatewayMode.Default,
          },
        },
      })
      const registry = makeRegistry([makeToolRecord('read_message')])

      const response = await handleInitialize(
        makeHandlerContext(Mode.Read),
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { mode: Mode.Read } },
        store,
        registry as never
      )

      const result = (response.result as { result: { instructions?: string } }).result
      expect(result.instructions).toBeUndefined()
    } finally {
      setConfig(previousConfig)
    }
  })

  it('publishes tools for the all namespace when a server is assigned there', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const previousConfig = getConfig()
    try {
      setConfig({
        ...previousConfig,
        namespaces: {
          ...previousConfig.namespaces,
          all: {
            allowedRoles: ['all'],
            bootstrapWindowSize: 4,
            candidatePoolSize: 16,
            allowedModes: ['read', 'write'],
          },
        },
        roles: {
          ...previousConfig.roles,
          all: {
            allowNamespaces: ['all'],
          },
        },
      })
      const request = {
        ...makeRequest(Mode.Read),
        headers: { authorization: 'Bearer alice:all' },
        params: { namespace: 'all' },
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { mode: Mode.Read },
        },
      } as unknown as FastifyRequest
      const registry = {
        getToolsByNamespace(namespace: string) {
          if (namespace !== 'all') return []
          return [
            {
              server: makeServer({ id: 'context7', namespaces: ['all'] }),
              records: [
                {
                  ...makeToolRecord('resolve-library-id', 'Resolve library ids', 'context7'),
                  namespace: 'all',
                },
              ],
            },
          ]
        },
        getHealthStates() {
          return {}
        },
      }

      const response = await handleInitialize(
        {
          namespace: (request.params as { namespace: string }).namespace,
          authorization: request.headers.authorization as string | undefined,
          requestId: 'test-req',
          log: undefined,
        },
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { mode: Mode.Read } },
        store,
        registry as never
      )

      const session = await store.get(response.id)
      expect(session?.namespace).toBe('all')
      // toolWindow now contains only gateway compat tools
      expect(session?.toolWindow).toHaveLength(3)
      expect(session?.toolWindow.map((t) => t.name)).toEqual([
        GATEWAY_SEARCH_TOOL_NAME,
        GATEWAY_CALL_TOOL_NAME,
        GATEWAY_LIST_SERVERS_TOOL_NAME,
      ])
      // bootstrap window should contain the downstream tool
      const selected = session?.lastSelectorDecision?.selected ?? []
      expect(selected).toHaveLength(1)
      expect(selected[0]).toMatchObject({
        name: 'resolve-library-id',
        serverId: 'context7',
      })
    } finally {
      setConfig(previousConfig)
    }
  })

  it('logs when initialize needs an OAuth bearer token', async () => {
    const previousConfig = getConfig()
    try {
      setConfig({
        ...previousConfig,
        auth: {
          mode: 'oauth',
          oauth: {
            provider: 'embedded',
            publicBaseUrl: 'https://gw.example.test',
            authorizationServers: [],
          },
        },
      })

      const info = vi.fn()
      const warn = vi.fn()
      const { store, close } = createTempSqliteSessionStore()
      disposeStore = () => {
        store.stop()
        close()
      }

      await expect(
        handleInitialize(
          {
            namespace: 'gmail',
            requestId: 'req-oauth-required',
            requestOrigin: 'https://gw.example.test',
            log: { info, warn } as never,
          },
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
          store,
          makeRegistry([]) as never
        ),
      ).rejects.toMatchObject({ code: 'OAUTH_AUTHENTICATION_REQUIRED' })

      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-oauth-required',
          namespace: 'gmail',
          requestOrigin: 'https://gw.example.test',
          authMode: 'oauth',
          oauthProvider: 'embedded',
        }),
        '[mcp] initialize requires OAuth bearer token',
      )
    } finally {
      setConfig(previousConfig)
    }
  })
})
