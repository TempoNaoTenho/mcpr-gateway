import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleToolsCall } from '../../src/gateway/dispatch/tools-call.js'
import type { McpHandlerContext } from '../../src/gateway/mcp-handler-context.js'
import { createTempSqliteSessionStore } from '../fixtures/sqlite-session-store.js'
import { GatewayMode, Mode, OutcomeClass, SessionStatus } from '../../src/types/enums.js'
import { GatewayError } from '../../src/types/errors.js'
import { SessionIdSchema } from '../../src/types/identity.js'
import type { SessionState } from '../../src/types/session.js'
import type { TriggerEngine } from '../../src/trigger/index.js'
import {
  GATEWAY_HELP_TOOL_NAME,
  GATEWAY_LIST_SERVERS_TOOL_NAME,
  GATEWAY_RUN_CODE_TOOL_NAME,
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

function makeTriggerEngine(): TriggerEngine {
  return { evaluate: vi.fn().mockResolvedValue(undefined) } as unknown as TriggerEngine
}

function makeSession(): SessionState {
  const now = new Date().toISOString()
  return {
    id: SessionIdSchema.parse('session-1'),
    userId: 'user-1',
    namespace: 'gmail',
    mode: Mode.Read,
    status: SessionStatus.Active,
    toolWindow: [],
    createdAt: now,
    lastActiveAt: now,
    refreshCount: 0,
    recentOutcomes: [],
    refreshHistory: [],
  }
}

function makeCtx(sessionId: string): McpHandlerContext {
  return {
    namespace: 'gmail',
    sessionId,
    requestId: 'test-req',
    log: undefined,
  }
}

function makeMockStore(session: SessionState) {
  return {
    get: vi.fn(async () => session),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => [session]),
  }
}

describe('handleToolsCall', () => {
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
          gatewayMode: GatewayMode.Default,
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
    })
  })

  afterEach(() => {
    disposeStore?.()
    disposeStore = undefined
  })

  it('rejects non-object tool arguments before dispatching downstream', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const session = makeSession()
    await store.set(session.id, session)

    const router = {
      route: vi.fn(),
    }

    await expect(
      handleToolsCall(
        makeCtx(session.id),
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'send_email', arguments: 'oops' as unknown as Record<string, unknown> },
        },
        store,
        router as never,
        makeTriggerEngine(),
      ),
    ).rejects.toMatchObject<Partial<GatewayError>>({
      code: 'INVALID_TOOL_ARGUMENTS',
      message: 'Tool arguments must be an object',
    })

    expect(router.route).not.toHaveBeenCalled()
  })

  it('maps ambiguous tool names to INVALID_TOOL_ARGUMENTS', async () => {
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    const session = makeSession()
    await store.set(session.id, session)

    const router = {
      route: vi.fn().mockResolvedValue({
        toolName: 'send_email',
        serverId: '',
        sessionId: session.id,
        outcome: OutcomeClass.ToolError,
        error: 'AMBIGUOUS_TOOL_NAME',
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }),
    }

    await expect(
      handleToolsCall(
        makeCtx(session.id),
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'send_email', arguments: {} },
        },
        store,
        router as never,
        makeTriggerEngine(),
      ),
    ).rejects.toMatchObject<Partial<GatewayError>>({
      code: 'INVALID_TOOL_ARGUMENTS',
      message: 'Tool name is ambiguous within the current session',
    })
  })

  it('wraps gateway_help results as MCP CallToolResult content', async () => {
    const session = {
      ...makeSession(),
      toolWindow: [
        {
          name: GATEWAY_HELP_TOOL_NAME,
          description: 'help',
          inputSchema: { type: 'object' },
          serverId: GATEWAY_SERVER_ID,
          namespace: 'gmail',
          riskLevel: 'Low',
          tags: [],
        },
      ],
    } as SessionState
    const store = makeMockStore(session)
    const router = {
      route: vi.fn().mockResolvedValue({
        toolName: GATEWAY_HELP_TOOL_NAME,
        serverId: GATEWAY_SERVER_ID,
        sessionId: session.id,
        outcome: OutcomeClass.Success,
        result: { topic: 'catalog', text: 'catalog.search(query)' },
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }),
    }

    const response = await handleToolsCall(
      makeCtx(session.id),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: GATEWAY_HELP_TOOL_NAME, arguments: { topic: 'catalog' } },
      },
      store as never,
      router as never,
      makeTriggerEngine(),
    )

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'catalog.search(query)' }],
        structuredContent: { topic: 'catalog', text: 'catalog.search(query)' },
      },
    })
  })

  it('wraps gateway_help catalog topic with updated search and result.limit guidance', async () => {
    const session = {
      ...makeSession(),
      toolWindow: [
        {
          name: GATEWAY_HELP_TOOL_NAME,
          description: 'help',
          inputSchema: { type: 'object' },
          serverId: GATEWAY_SERVER_ID,
          namespace: 'gmail',
          riskLevel: 'Low',
          tags: [],
        },
      ],
    } as SessionState
    const store = makeMockStore(session)

    const router = {
      route: vi.fn().mockResolvedValue({
        toolName: GATEWAY_HELP_TOOL_NAME,
        serverId: GATEWAY_SERVER_ID,
        sessionId: session.id,
        outcome: OutcomeClass.Success,
        durationMs: 0,
        timestamp: new Date().toISOString(),
        result: {
          topic: 'catalog',
          text: 'catalog.search(query, { k, limit, serverId, risk, tags, requiredArgs, detail })\nresult.limit(array, n)',
        },
      }),
    }

    const response = await handleToolsCall(
      makeCtx(session.id),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: GATEWAY_HELP_TOOL_NAME, arguments: { topic: 'catalog' } },
      },
      store as never,
      router as never,
      makeTriggerEngine(),
    )

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining(
              'catalog.search(query, { k, limit, serverId, risk, tags, requiredArgs, detail })'
            ),
          },
        ],
        structuredContent: {
          topic: 'catalog',
          text: expect.stringContaining(
            'catalog.search(query, { k, limit, serverId, risk, tags, requiredArgs, detail })'
          ),
        },
      },
    })
  })

  it('wraps gateway_search_tools results as MCP CallToolResult content', async () => {
    const session = {
      ...makeSession(),
      toolWindow: [
        {
          name: GATEWAY_SEARCH_TOOL_NAME,
          description: 'search',
          inputSchema: { type: 'object' },
          serverId: GATEWAY_SERVER_ID,
          namespace: 'gmail',
          riskLevel: 'Low',
          tags: [],
        },
      ],
    } as SessionState
    const store = makeMockStore(session)
    const result = {
      query: 'fastmcp quickstart',
      matches: [
        {
          name: 'search_fast_mcp',
          serverId: 'fastmcp',
          description: 'Search the FastMCP knowledge base',
        },
      ],
    }
    const router = {
      route: vi.fn().mockResolvedValue({
        toolName: GATEWAY_SEARCH_TOOL_NAME,
        serverId: GATEWAY_SERVER_ID,
        sessionId: session.id,
        outcome: OutcomeClass.Success,
        result,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }),
    }

    const response = await handleToolsCall(
      makeCtx(session.id),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: GATEWAY_SEARCH_TOOL_NAME, arguments: { query: 'fastmcp quickstart' } },
      },
      store as never,
      router as never,
      makeTriggerEngine(),
    )

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining('search_fast_mcp (fastmcp)'),
          },
        ],
        structuredContent: result,
      },
    })
  })

  it('wraps gateway_search_and_call_tool results as MCP CallToolResult content', async () => {
    const session = {
      ...makeSession(),
      toolWindow: [
        {
          name: GATEWAY_SEARCH_AND_CALL_TOOL_NAME,
          description: 'search and call',
          inputSchema: { type: 'object' },
          serverId: GATEWAY_SERVER_ID,
          namespace: 'gmail',
          riskLevel: 'Low',
          tags: [],
        },
      ],
    } as SessionState
    const store = makeMockStore(session)
    const result = {
      query: 'fastmcp quickstart',
      match: {
        name: 'search_fast_mcp',
        serverId: 'fastmcp',
      },
      result: { content: [{ type: 'text', text: 'Quickstart docs' }] },
    }
    const router = {
      route: vi.fn().mockResolvedValue({
        toolName: GATEWAY_SEARCH_AND_CALL_TOOL_NAME,
        serverId: GATEWAY_SERVER_ID,
        sessionId: session.id,
        outcome: OutcomeClass.Success,
        result,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }),
    }

    const response = await handleToolsCall(
      makeCtx(session.id),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: GATEWAY_SEARCH_AND_CALL_TOOL_NAME,
          arguments: { query: 'fastmcp quickstart', arguments: { query: 'quickstart' } },
        },
      },
      store as never,
      router as never,
      makeTriggerEngine(),
    )

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.stringContaining('Selected match: search_fast_mcp (fastmcp)') }],
        structuredContent: result,
      },
    })
  })

  it('wraps gateway_list_servers results as MCP CallToolResult content', async () => {
    const session = {
      ...makeSession(),
      toolWindow: [
        {
          name: GATEWAY_LIST_SERVERS_TOOL_NAME,
          description: 'list servers',
          inputSchema: { type: 'object' },
          serverId: GATEWAY_SERVER_ID,
          namespace: 'gmail',
          riskLevel: 'Low',
          tags: [],
        },
      ],
    } as SessionState
    const store = makeMockStore(session)
    const result = {
      servers: [{ serverId: 'docs' }, { serverId: 'fastmcp' }],
    }
    const router = {
      route: vi.fn().mockResolvedValue({
        toolName: GATEWAY_LIST_SERVERS_TOOL_NAME,
        serverId: GATEWAY_SERVER_ID,
        sessionId: session.id,
        outcome: OutcomeClass.Success,
        result,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }),
    }

    const response = await handleToolsCall(
      makeCtx(session.id),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: GATEWAY_LIST_SERVERS_TOOL_NAME, arguments: {} },
      },
      store as never,
      router as never,
      makeTriggerEngine(),
    )

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining('Available downstream servers:'),
          },
        ],
        structuredContent: result,
      },
    })
  })

  it('wraps gateway_run_code results as MCP CallToolResult content', async () => {
    const session = {
      ...makeSession(),
      toolWindow: [
        {
          name: GATEWAY_RUN_CODE_TOOL_NAME,
          description: 'code',
          inputSchema: { type: 'object' },
          serverId: GATEWAY_SERVER_ID,
          namespace: 'gmail',
          riskLevel: 'Low',
          tags: [],
        },
      ],
    } as SessionState
    const store = makeMockStore(session)
    const result = {
      backend: 'isolated-vm',
      value: 2,
      telemetry: {
        latencyMs: 12,
        requestBytes: 10,
        responseBytes: 12,
        requestTokensEstimate: 3,
        responseTokensEstimate: 3,
        totalTokensEstimate: 6,
        toolCalls: [],
      },
    }
    const router = {
      route: vi.fn().mockResolvedValue({
        toolName: GATEWAY_RUN_CODE_TOOL_NAME,
        serverId: GATEWAY_SERVER_ID,
        sessionId: session.id,
        outcome: OutcomeClass.Success,
        result,
        telemetry: {
          latencyMs: 12,
          requestBytes: 10,
          responseBytes: 12,
          requestTokensEstimate: 3,
          responseTokensEstimate: 3,
          totalTokensEstimate: 6,
        },
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }),
    }

    const response = await handleToolsCall(
      makeCtx(session.id),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: GATEWAY_RUN_CODE_TOOL_NAME, arguments: { code: '1 + 1' } },
      },
      store as never,
      router as never,
      makeTriggerEngine(),
    )

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: '2' }],
        structuredContent: result,
      },
    })
  })

  it('preserves downstream CallToolResult payloads for non-internal tools', async () => {
    const session = {
      ...makeSession(),
      toolWindow: [
        {
          name: 'search_docs',
          description: 'docs',
          inputSchema: { type: 'object' },
          serverId: 'fastmcp',
          namespace: 'gmail',
          riskLevel: 'Low',
          tags: [],
        },
      ],
    } as SessionState
    const store = makeMockStore(session)
    const downstreamResult = {
      content: [{ type: 'text', text: 'From downstream' }],
    }
    const router = {
      route: vi.fn().mockResolvedValue({
        toolName: 'search_docs',
        serverId: 'fastmcp',
        sessionId: session.id,
        outcome: OutcomeClass.Success,
        result: downstreamResult,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      }),
    }

    const response = await handleToolsCall(
      makeCtx(session.id),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_docs', arguments: { query: 'quickstart' } },
      },
      store as never,
      router as never,
      makeTriggerEngine(),
    )

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: downstreamResult,
    })
  })
})
