import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionRouter } from '../../src/router/router.js'
import { createTempSqliteSessionStore } from '../fixtures/sqlite-session-store.js'
import { GatewayMode, Mode, OutcomeClass, SessionStatus, ToolRiskLevel } from '../../src/types/enums.js'
import { SessionIdSchema } from '../../src/types/identity.js'
import { SourceTrustLevel } from '../../src/types/enums.js'
import type { SessionState } from '../../src/types/session.js'
import type { DownstreamServer } from '../../src/types/server.js'
import type { VisibleTool } from '../../src/types/tools.js'
import { setConfig } from '../../src/config/index.js'
import {
  GATEWAY_DISCOVERY_SERVER_ID,
  GATEWAY_DISCOVERY_TOOL_NAME,
  GATEWAY_HELP_TOOL_NAME,
  GATEWAY_SERVER_ID,
} from '../../src/gateway/discovery.js'
import { defaultDebug, defaultResilience, defaultSelector, defaultSession, defaultTriggers } from '../fixtures/bootstrap-json.js'

function makeTool(name: string, serverId: string): VisibleTool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object' },
    serverId,
    namespace: 'gmail',
    riskLevel: ToolRiskLevel.Low,
    tags: [],
  }
}

function makeSession(toolWindow: VisibleTool[]): SessionState {
  const now = new Date().toISOString()
  return {
    id: SessionIdSchema.parse('session-1'),
    userId: 'user-1',
    namespace: 'gmail',
    mode: Mode.Read,
    status: SessionStatus.Active,
    toolWindow,
    createdAt: now,
    lastActiveAt: now,
    refreshCount: 0,
    recentOutcomes: [],
    refreshHistory: [],
    pendingToolListChange: false,
  }
}

function makeServer(id: string): DownstreamServer {
  return {
    id,
    namespaces: ['gmail'],
    transport: 'http',
    url: 'https://example.com/mcp',
    enabled: true,
    trustLevel: SourceTrustLevel.Verified,
  }
}

function enableDiscoveryTool(): void {
  setConfig({
    servers: [],
    auth: { mode: 'mock_dev' },
    namespaces: {
      gmail: {
        allowedRoles: ['user'],
        bootstrapWindowSize: 4,
        candidatePoolSize: 8,
        allowedModes: ['read', 'write'],
        gatewayMode: GatewayMode.Compat,
        disabledTools: [],
      },
    },
    roles: { user: { allowNamespaces: ['gmail'] } },
    selector: {
      ...defaultSelector,
      discoveryTool: { enabled: true, resultLimit: 5, promoteCount: 2 },
    },
    session: defaultSession,
    triggers: defaultTriggers,
    resilience: defaultResilience,
    debug: defaultDebug,
    starterPacks: {},
  })
}

describe('ExecutionRouter', () => {
  let disposeStore: (() => void) | undefined
  afterEach(() => {
    disposeStore?.()
    disposeStore = undefined
  })

  it('rejects ambiguous tool names instead of routing to the first match', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const session = makeSession([
      makeTool('send_email', 'gmail-primary'),
      makeTool('send_email', 'gmail-secondary'),
    ])
    await store.set(session.id, session)

    const registry = {
      getServer: vi.fn(),
    }

    const router = new ExecutionRouter(registry as never, store)
    const outcome = await router.route('send_email', {}, session.id)

    expect(outcome.outcome).toBe(OutcomeClass.ToolError)
    expect(outcome.error).toBe('AMBIGUOUS_TOOL_NAME')
    expect(outcome.serverId).toBe('')
    expect(registry.getServer).not.toHaveBeenCalled()
  })

  it('does not resolve a server when the visible tool name is ambiguous', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const session = makeSession([
      makeTool('send_email', 'gmail-primary'),
      makeTool('send_email', 'gmail-secondary'),
    ])
    await store.set(session.id, session)

    const registry = {
      getServer: vi.fn(async (id: string) => makeServer(id)),
    }

    const router = new ExecutionRouter(registry as never, store)
    const server = await router.resolveServer('send_email', session.id)

    expect(server).toBeUndefined()
    expect(registry.getServer).not.toHaveBeenCalled()
  })

  it('executes the gateway discovery tool locally and promotes hidden tools into the session window', async () => {
    enableDiscoveryTool()

    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const session = makeSession([
      makeTool(GATEWAY_DISCOVERY_TOOL_NAME, GATEWAY_DISCOVERY_SERVER_ID),
    ])
    await store.set(session.id, session)

    const registry = {
      getServer: vi.fn(),
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('docs'),
          records: [
            {
              name: 'search_docs',
              description: 'Search docs and product documentation',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
              serverId: 'docs',
              namespace: 'gmail',
              retrievedAt: new Date().toISOString(),
              sanitized: true,
            },
            {
              name: 'read_file',
              description: 'Read a file',
              inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
              serverId: 'docs',
              namespace: 'gmail',
              retrievedAt: new Date().toISOString(),
              sanitized: true,
            },
          ],
        },
      ]),
    }

    const router = new ExecutionRouter(registry as never, store)
    const outcome = await router.route(GATEWAY_DISCOVERY_TOOL_NAME, { query: 'product documentation search' }, session.id)
    const updated = await store.get(session.id)

    expect(outcome.outcome).toBe(OutcomeClass.Success)
    expect(outcome.serverId).toBe(GATEWAY_DISCOVERY_SERVER_ID)
    expect(updated?.toolWindow.map((tool) => tool.name)).toContain('search_docs')
    expect(updated?.pendingToolListChange).toBe(true)
    expect((outcome.result as { matches: Array<{ search: { strategy: string } }> }).matches[0]?.search.strategy).toBe('bm25')
    expect(registry.getServer).not.toHaveBeenCalled()
  })

  it('returns runtime help for gateway_help without touching downstream servers', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const session = makeSession([
      makeTool(GATEWAY_HELP_TOOL_NAME, GATEWAY_SERVER_ID),
    ])
    await store.set(session.id, session)

    const registry = {
      getServer: vi.fn(),
    }

    const router = new ExecutionRouter(registry as never, store)
    const outcome = await router.route(GATEWAY_HELP_TOOL_NAME, { topic: 'catalog' }, session.id)

    expect(outcome.outcome).toBe(OutcomeClass.Success)
    expect(outcome.serverId).toBe(GATEWAY_SERVER_ID)
    expect((outcome.result as { topic: string }).topic).toBe('catalog')
    expect(registry.getServer).not.toHaveBeenCalled()
  })
})
