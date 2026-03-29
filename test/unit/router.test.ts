import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecutionRouter } from '../../src/router/router.js'
import { createTempSqliteSessionStore } from '../fixtures/sqlite-session-store.js'
import { GatewayMode, Mode, OutcomeClass, SessionStatus, ToolRiskLevel } from '../../src/types/enums.js'
import { SessionIdSchema } from '../../src/types/identity.js'
import { SourceTrustLevel } from '../../src/types/enums.js'
import type { SessionState } from '../../src/types/session.js'
import type { DownstreamServer } from '../../src/types/server.js'
import type { VisibleTool } from '../../src/types/tools.js'
import {
  GATEWAY_CALL_TOOL_NAME,
  GATEWAY_HELP_TOOL_NAME,
  GATEWAY_LIST_SERVERS_TOOL_NAME,
  GATEWAY_SEARCH_AND_CALL_TOOL_NAME,
  GATEWAY_SEARCH_TOOL_NAME,
  GATEWAY_SERVER_ID,
} from '../../src/gateway/discovery.js'
import { setConfig } from '../../src/config/index.js'
import {
  defaultDebug,
  defaultResilience,
  defaultSelector,
  defaultSession,
  defaultTriggers,
} from '../fixtures/bootstrap-json.js'

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

describe('ExecutionRouter', () => {
  let disposeStore: (() => void) | undefined
  beforeEach(() => {
    setConfig({
      servers: [],
      auth: { mode: 'static_key' },
      namespaces: {
        gmail: {
          allowedRoles: ['user'],
          bootstrapWindowSize: 4,
          candidatePoolSize: 16,
          allowedModes: [Mode.Read, Mode.Write],
          gatewayMode: GatewayMode.Compat,
          telemetryEnabled: false,
          disabledTools: [],
        },
      },
      roles: {
        user: {
          allowNamespaces: ['gmail'],
        },
      },
      selector: defaultSelector,
      session: defaultSession,
      triggers: defaultTriggers,
      resilience: defaultResilience,
      debug: defaultDebug,
      starterPacks: {},
      allowedOAuthProviders: [],
      codeMode: {
        memoryLimitMb: 128,
        executionTimeoutMs: 10_000,
        maxToolCallsPerExecution: 20,
        maxResultSizeBytes: 1_048_576,
        artifactStoreTtlSeconds: 300,
        maxConcurrentToolCalls: 5,
      },
    })
  })

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

  it('does not route removed gateway_find_tools builtin', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const session = makeSession([makeTool('read_email', 'gmail-primary')])
    await store.set(session.id, session)

    const registry = {
      getServer: vi.fn(),
      getToolsByNamespace: vi.fn(),
    }

    const router = new ExecutionRouter(registry as never, store)
    const outcome = await router.route('gateway_find_tools', { query: 'docs' }, session.id)

    expect(outcome.outcome).toBe(OutcomeClass.ToolError)
    expect(outcome.error).toBe('TOOL_NOT_VISIBLE')
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

  it('returns gateway_list_servers without resolving downstream servers directly', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const session = makeSession([makeTool(GATEWAY_LIST_SERVERS_TOOL_NAME, GATEWAY_SERVER_ID)])
    await store.set(session.id, session)

    const registry = {
      getServer: vi.fn(),
      getToolsByNamespace: vi.fn(() => [
        { server: makeServer('gmail-primary'), records: [makeTool('read_email', 'gmail-primary')] },
        { server: makeServer('docs'), records: [makeTool('search_docs', 'docs')] },
      ]),
    }

    const router = new ExecutionRouter(registry as never, store)
    const outcome = await router.route(GATEWAY_LIST_SERVERS_TOOL_NAME, {}, session.id)

    expect(outcome.outcome).toBe(OutcomeClass.Success)
    expect(outcome.serverId).toBe(GATEWAY_SERVER_ID)
    expect(outcome.result).toEqual({
      servers: [{ serverId: 'docs' }, { serverId: 'gmail-primary' }],
    })
    expect(registry.getServer).not.toHaveBeenCalled()
  })

  it('omits telemetry when the namespace toggle is disabled', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const session = makeSession([makeTool(GATEWAY_LIST_SERVERS_TOOL_NAME, GATEWAY_SERVER_ID)])
    await store.set(session.id, session)

    const registry = {
      getServer: vi.fn(),
      getToolsByNamespace: vi.fn(() => [
        { server: makeServer('gmail-primary'), records: [makeTool('read_email', 'gmail-primary')] },
      ]),
    }

    const router = new ExecutionRouter(registry as never, store)
    const outcome = await router.route(GATEWAY_LIST_SERVERS_TOOL_NAME, {}, session.id)

    expect(outcome.outcome).toBe(OutcomeClass.Success)
    expect(outcome.telemetry).toBeUndefined()
  })

  it('returns telemetry when the namespace toggle is enabled', async () => {
    setConfig({
      servers: [],
      auth: { mode: 'static_key' },
      namespaces: {
        gmail: {
          allowedRoles: ['user'],
          bootstrapWindowSize: 4,
          candidatePoolSize: 16,
          allowedModes: [Mode.Read, Mode.Write],
          gatewayMode: GatewayMode.Compat,
          telemetryEnabled: true,
          disabledTools: [],
        },
      },
      roles: {
        user: {
          allowNamespaces: ['gmail'],
        },
      },
      selector: defaultSelector,
      session: defaultSession,
      triggers: defaultTriggers,
      resilience: defaultResilience,
      debug: defaultDebug,
      starterPacks: {},
      allowedOAuthProviders: [],
      codeMode: {
        memoryLimitMb: 128,
        executionTimeoutMs: 10_000,
        maxToolCallsPerExecution: 20,
        maxResultSizeBytes: 1_048_576,
        artifactStoreTtlSeconds: 300,
        maxConcurrentToolCalls: 5,
      },
    })

    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const session = makeSession([makeTool(GATEWAY_LIST_SERVERS_TOOL_NAME, GATEWAY_SERVER_ID)])
    await store.set(session.id, session)

    const registry = {
      getServer: vi.fn(),
      getToolsByNamespace: vi.fn(() => [
        { server: makeServer('gmail-primary'), records: [makeTool('read_email', 'gmail-primary')] },
      ]),
    }

    const router = new ExecutionRouter(registry as never, store)
    const outcome = await router.route(GATEWAY_LIST_SERVERS_TOOL_NAME, {}, session.id)

    expect(outcome.outcome).toBe(OutcomeClass.Success)
    expect(outcome.telemetry).toEqual(
      expect.objectContaining({
        latencyMs: expect.any(Number),
        totalTokensEstimate: expect.any(Number),
      }),
    )
  })

  it('rejects gateway meta-tools when they are not visible in the session window', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const session = makeSession([makeTool('read_email', 'gmail-primary')])
    await store.set(session.id, session)

    const registry = {
      getServer: vi.fn(),
      getToolsByNamespace: vi.fn(),
    }

    const router = new ExecutionRouter(registry as never, store)
    const searchOutcome = await router.route(GATEWAY_SEARCH_TOOL_NAME, { query: 'email' }, session.id)
    const callOutcome = await router.route(
      GATEWAY_CALL_TOOL_NAME,
      { name: 'read_email', serverId: 'gmail-primary', arguments: {} },
      session.id,
    )
    const searchAndCallOutcome = await router.route(
      GATEWAY_SEARCH_AND_CALL_TOOL_NAME,
      { query: 'read email', arguments: {} },
      session.id,
    )
    const listServersOutcome = await router.route(GATEWAY_LIST_SERVERS_TOOL_NAME, {}, session.id)

    expect(searchOutcome.outcome).toBe(OutcomeClass.ToolError)
    expect(searchOutcome.error).toBe('TOOL_NOT_VISIBLE')
    expect(callOutcome.outcome).toBe(OutcomeClass.ToolError)
    expect(callOutcome.error).toBe('TOOL_NOT_VISIBLE')
    expect(searchAndCallOutcome.outcome).toBe(OutcomeClass.ToolError)
    expect(searchAndCallOutcome.error).toBe('TOOL_NOT_VISIBLE')
    expect(listServersOutcome.outcome).toBe(OutcomeClass.ToolError)
    expect(listServersOutcome.error).toBe('TOOL_NOT_VISIBLE')
    expect(registry.getServer).not.toHaveBeenCalled()
  })
})
