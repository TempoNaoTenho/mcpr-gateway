import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getConfig, initConfig, setConfig } from '../../src/config/index.js'
import {
  defaultDebug,
  defaultResilience,
  defaultSelector,
  defaultSession,
} from '../fixtures/bootstrap-json.js'
import { createTempSqliteSessionStore } from '../fixtures/sqlite-session-store.js'
import { TriggerEngine } from '../../src/trigger/index.js'
import {
  DownstreamHealth,
  GatewayMode,
  Mode,
  OutcomeClass,
  RefreshTriggerType,
  SessionStatus,
  SourceTrustLevel,
  ToolRiskLevel,
} from '../../src/types/enums.js'
import { SessionIdSchema } from '../../src/types/identity.js'
import type { ExecutionOutcome } from '../../src/types/execution.js'
import type { SessionState } from '../../src/types/session.js'
import type { SelectorDecision } from '../../src/types/selector.js'
import type { DownstreamServer } from '../../src/types/server.js'
import type { ToolRecord, VisibleTool } from '../../src/types/tools.js'
import {
  GATEWAY_SEARCH_TOOL_NAME,
  GATEWAY_CALL_TOOL_NAME,
  GATEWAY_RUN_CODE_TOOL_NAME,
  GATEWAY_HELP_TOOL_NAME,
} from '../../src/gateway/discovery.js'

const TMP = mkdtempSync(join(tmpdir(), 'mcp-session-gateway-trigger-'))

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  writeConfig()
})

function writeConfig(
  overrides: Partial<{
    refreshOnSuccess: boolean
    refreshOnTimeout: boolean
    refreshOnError: boolean
    replaceOrAppend: 'replace' | 'append'
    cooldownSeconds: number
    candidatePoolSize: number
  }> = {},
): void {
  const {
    refreshOnSuccess = false,
    refreshOnTimeout = true,
    refreshOnError = true,
    replaceOrAppend = 'replace',
    cooldownSeconds = 0,
    candidatePoolSize = 8,
  } = overrides

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
        auth: { mode: 'mock_dev' },
        namespaces: {
          gmail: {
            allowedRoles: ['user'],
            bootstrapWindowSize: 4,
            candidatePoolSize,
            allowedModes: ['read', 'write'],
          },
        },
        roles: {
          user: {
            allowNamespaces: ['gmail'],
          },
        },
        selector: defaultSelector,
        session: defaultSession,
        triggers: {
          refreshOnSuccess,
          refreshOnTimeout,
          refreshOnError,
          replaceOrAppend,
          cooldownSeconds,
        },
        resilience: defaultResilience,
        debug: defaultDebug,
        starterPacks: {},
      },
      null,
      2,
    ),
  )
  initConfig(TMP)
}

function makeServer(id: string): DownstreamServer {
  return {
    id,
    namespaces: ['gmail'],
    transport: 'http',
    url: 'https://example.com/mcp',
    enabled: true,
    trustLevel: SourceTrustLevel.Internal,
  }
}

function makeTool(name: string, serverId: string): VisibleTool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object' },
    serverId,
    namespace: 'gmail',
    riskLevel: ToolRiskLevel.Low,
    tags: [name],
  }
}

function makeToolRecord(name: string, serverId: string): ToolRecord {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object' },
    serverId,
    namespace: 'gmail',
    retrievedAt: '2026-03-17T20:00:00.000Z',
    sanitized: true,
  }
}

function makeOutcome(
  toolName: string,
  outcome: OutcomeClass,
  serverId: string,
  overrides: Partial<ExecutionOutcome> = {},
): ExecutionOutcome {
  return {
    toolName,
    serverId,
    sessionId: SessionIdSchema.parse('session-1'),
    outcome,
    durationMs: 5,
    timestamp: '2026-03-17T20:00:00.000Z',
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  const now = '2026-03-17T19:59:00.000Z'
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
    resolvedPolicy: {
      namespacePolicy: {
        candidatePoolSize: 8,
      },
    },
    ...overrides,
  }
}

function makeDecision(selected: VisibleTool[], triggeredBy = RefreshTriggerType.ExplicitRequest): SelectorDecision {
  return {
    selected,
    reasoning: 'test decision',
    triggeredBy,
    timestamp: '2026-03-17T20:00:01.000Z',
  }
}

describe('TriggerEngine', () => {
  let disposeStore: (() => void) | undefined
  afterEach(() => {
    disposeStore?.()
    disposeStore = undefined
  })

  it('refreshes on the first successful downstream call even when that outcome was already persisted', async () => {
    writeConfig({ refreshOnSuccess: true, refreshOnError: false })

    const outcome = makeOutcome('send_email', OutcomeClass.Success, 'gmail-server')
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    await store.set(
      SessionIdSchema.parse('session-1'),
      makeSession({ recentOutcomes: [outcome] }),
    )

    const selector = {
      select: vi.fn().mockResolvedValue(makeDecision([makeTool('archive_email', 'gmail-server')])),
      rerank: vi.fn(),
    }
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('gmail-server'),
          records: [],
        },
      ]),
      getHealthStates: vi.fn().mockReturnValue({}),
    }

    const engine = new TriggerEngine(store, registry as never, selector as never)
    await engine.evaluate(SessionIdSchema.parse('session-1'), outcome)

    const updated = await store.get(SessionIdSchema.parse('session-1'))
    expect(selector.select).toHaveBeenCalledOnce()
    expect(selector.select).toHaveBeenCalledWith(expect.objectContaining({
      initialIntentText: undefined,
    }))
    expect(updated?.refreshCount).toBe(1)
    expect(updated?.refreshHistory.at(-1)?.triggeredBy).toBe(
      RefreshTriggerType.FirstSuccessInDomain,
    )
    // After refresh, toolWindow is always just the gateway meta-tools
    expect(updated?.toolWindow.map((tool) => tool.name)).toEqual([GATEWAY_SEARCH_TOOL_NAME, GATEWAY_CALL_TOOL_NAME])
  })

  it('passes the initial session intent through refresh recomputation', async () => {
    writeConfig({ refreshOnSuccess: true, refreshOnError: false })

    const outcome = makeOutcome('read_docs', OutcomeClass.Success, 'docs-server')
    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    await store.set(
      SessionIdSchema.parse('session-1'),
      makeSession({
        initialIntentText: 'Need API docs and SDK reference',
        recentOutcomes: [outcome],
      }),
    )

    const selector = {
      select: vi.fn().mockResolvedValue(makeDecision([makeTool('resolve_library_reference', 'docs-server')])),
      rerank: vi.fn(),
    }
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('docs-server'),
          records: [makeToolRecord('resolve_library_reference', 'docs-server')],
        },
      ]),
      getHealthStates: vi.fn().mockReturnValue({}),
    }

    const engine = new TriggerEngine(store, registry as never, selector as never)
    await engine.evaluate(SessionIdSchema.parse('session-1'), outcome)

    expect(selector.select).toHaveBeenCalledWith(expect.objectContaining({
      initialIntentText: 'Need API docs and SDK reference',
    }))
    const updated = await store.get(SessionIdSchema.parse('session-1'))
    expect(updated?.initialIntentText).toBe('Need API docs and SDK reference')
  })

  it('keeps all tools when appending after refresh without truncating the window', async () => {
    writeConfig({ refreshOnError: true, replaceOrAppend: 'append' })

    const currentWindow = [makeTool('search_email', 'gmail-server'), makeTool('read_email', 'gmail-server')]
    const outcome = makeOutcome('read_email', OutcomeClass.ToolError, 'gmail-server', {
      error: 'Downstream tool failed',
    })

    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    await store.set(
      SessionIdSchema.parse('session-1'),
      makeSession({
        toolWindow: currentWindow,
        recentOutcomes: [outcome],
        resolvedPolicy: {
          namespacePolicy: {
            candidatePoolSize: 8,
          },
        },
      }),
    )

    const selector = {
      select: vi
        .fn()
        .mockResolvedValue(makeDecision([makeTool('read_email', 'gmail-server'), makeTool('draft_reply', 'gmail-server')])),
      rerank: vi.fn(),
    }
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('gmail-server'),
          records: [],
        },
      ]),
      getHealthStates: vi.fn().mockReturnValue({}),
    }

    const engine = new TriggerEngine(store, registry as never, selector as never)
    await engine.evaluate(SessionIdSchema.parse('session-1'), outcome)

    const updated = await store.get(SessionIdSchema.parse('session-1'))
    // After refresh, toolWindow is always just the gateway meta-tools
    expect(updated?.toolWindow.map((tool) => tool.name)).toEqual([GATEWAY_SEARCH_TOOL_NAME, GATEWAY_CALL_TOOL_NAME])
  })

  it('preserves gateway meta-tools across refreshes', async () => {
    writeConfig({ refreshOnError: true })

    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    await store.set(
      SessionIdSchema.parse('session-1'),
      makeSession({
        toolWindow: [
          makeTool('read_email', 'gmail-server'),
        ],
        recentOutcomes: [makeOutcome('read_email', OutcomeClass.ToolError, 'gmail-server', { error: 'failed' })],
      }),
    )

    const selector = {
      select: vi.fn().mockResolvedValue(makeDecision([makeTool('draft_reply', 'gmail-server')])),
      rerank: vi.fn(),
    }
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('gmail-server'),
          records: [makeToolRecord('draft_reply', 'gmail-server')],
        },
      ]),
      getHealthStates: vi.fn().mockReturnValue({}),
    }

    const engine = new TriggerEngine(store, registry as never, selector as never)
    await engine.evaluate(
      SessionIdSchema.parse('session-1'),
      makeOutcome('read_email', OutcomeClass.ToolError, 'gmail-server', { error: 'failed' }),
    )

    const updated = await store.get(SessionIdSchema.parse('session-1'))
    const toolNames = updated?.toolWindow.map((tool) => tool.name) ?? []
    expect(toolNames).toContain(GATEWAY_SEARCH_TOOL_NAME)
    expect(toolNames).toContain(GATEWAY_CALL_TOOL_NAME)
  })

  it('preserves code-mode gateway tools across refreshes', async () => {
    writeConfig({ refreshOnError: true })

    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    await store.set(
      SessionIdSchema.parse('session-1'),
      makeSession({
        toolWindow: [
          makeTool(GATEWAY_RUN_CODE_TOOL_NAME, '__gateway__'),
          makeTool(GATEWAY_HELP_TOOL_NAME, '__gateway__'),
        ],
        resolvedPolicy: {
          namespacePolicy: {
            candidatePoolSize: 8,
            gatewayMode: GatewayMode.Code,
          },
        },
        recentOutcomes: [makeOutcome('read_email', OutcomeClass.ToolError, 'gmail-server', { error: 'failed' })],
      }),
    )

    const selector = {
      select: vi.fn().mockResolvedValue(makeDecision([makeTool('draft_reply', 'gmail-server')])),
      rerank: vi.fn(),
    }
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('gmail-server'),
          records: [makeToolRecord('draft_reply', 'gmail-server')],
        },
      ]),
      getHealthStates: vi.fn().mockReturnValue({}),
    }

    const engine = new TriggerEngine(store, registry as never, selector as never)
    await engine.evaluate(
      SessionIdSchema.parse('session-1'),
      makeOutcome('read_email', OutcomeClass.ToolError, 'gmail-server', { error: 'failed' }),
    )

    const updated = await store.get(SessionIdSchema.parse('session-1'))
    expect(updated?.toolWindow.map((tool) => tool.name)).toEqual([
      GATEWAY_RUN_CODE_TOOL_NAME,
      GATEWAY_HELP_TOOL_NAME,
    ])
  })

  it('rebuilds the downstream catalog directly in default mode', async () => {
    writeConfig({ refreshOnError: true })

    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    await store.set(
      SessionIdSchema.parse('session-1'),
      makeSession({
        toolWindow: [makeTool('stale_tool', 'gmail-server')],
        resolvedPolicy: {
          namespacePolicy: {
            candidatePoolSize: 8,
            gatewayMode: GatewayMode.Default,
          },
        },
        recentOutcomes: [makeOutcome('read_email', OutcomeClass.ToolError, 'gmail-server', { error: 'failed' })],
      }),
    )

    const selector = {
      select: vi.fn(),
      rerank: vi.fn(),
    }
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('gmail-server'),
          records: [
            makeToolRecord('read_email', 'gmail-server'),
            makeToolRecord('delete_email', 'gmail-server'),
          ],
        },
      ]),
      getHealthStates: vi.fn().mockReturnValue({}),
    }

    const previousConfig = getConfig()
    setConfig({
      ...previousConfig,
      namespaces: {
        ...previousConfig.namespaces,
        gmail: {
          ...previousConfig.namespaces.gmail,
          gatewayMode: GatewayMode.Default,
          disabledTools: [{ serverId: 'gmail-server', name: 'delete_email' }],
        },
      },
    })

    try {
      const engine = new TriggerEngine(store, registry as never, selector as never)
      await engine.evaluate(
        SessionIdSchema.parse('session-1'),
        makeOutcome('read_email', OutcomeClass.ToolError, 'gmail-server', { error: 'failed' }),
      )

      const updated = await store.get(SessionIdSchema.parse('session-1'))
      expect(selector.select).not.toHaveBeenCalled()
      expect(updated?.toolWindow.map((tool) => tool.name)).toEqual(['read_email'])
      expect(updated?.lastSelectorDecision?.reasoning).toBe('direct_catalog')
      expect(updated?.refreshHistory.at(-1)?.toolCount).toBe(1)
    } finally {
      setConfig(previousConfig)
    }
  })

  it('treats downstream tool errors as refresh-on-error triggers', async () => {
    writeConfig({ refreshOnError: true })

    const outcome = makeOutcome('send_email', OutcomeClass.ToolError, 'gmail-server', {
      error: 'provider rejected request',
    })

    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    await store.set(
      SessionIdSchema.parse('session-1'),
      makeSession({ recentOutcomes: [outcome] }),
    )

    const selector = {
      select: vi.fn().mockResolvedValue(makeDecision([makeTool('retry_send', 'gmail-server')])),
      rerank: vi.fn(),
    }
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('gmail-server'),
          records: [],
        },
      ]),
      getHealthStates: vi.fn().mockReturnValue({}),
    }

    const engine = new TriggerEngine(store, registry as never, selector as never)
    await engine.evaluate(SessionIdSchema.parse('session-1'), outcome)

    const updated = await store.get(SessionIdSchema.parse('session-1'))
    expect(selector.select).toHaveBeenCalledOnce()
    expect(updated?.refreshCount).toBe(1)
    expect(updated?.refreshHistory.at(-1)?.triggeredBy).toBe(RefreshTriggerType.ErrorThreshold)
  })

  it('filters offline downstream tools before selector reranking on refresh', async () => {
    writeConfig({ refreshOnError: true })

    const outcome = makeOutcome('send_email', OutcomeClass.ToolError, 'gmail-server', {
      error: 'provider rejected request',
    })

    const { store, close } = createTempSqliteSessionStore()
    disposeStore = () => {
      store.stop()
      close()
    }
    await store.set(
      SessionIdSchema.parse('session-1'),
      makeSession({ recentOutcomes: [outcome] }),
    )

    const selector = {
      select: vi.fn().mockResolvedValue(makeDecision([makeTool('read_email', 'gmail-server')])),
      rerank: vi.fn(),
    }
    const registry = {
      getToolsByNamespace: vi.fn().mockReturnValue([
        {
          server: makeServer('offline-server'),
          records: [makeToolRecord('email_archive', 'offline-server')],
        },
        {
          server: makeServer('gmail-server'),
          records: [makeToolRecord('email_read', 'gmail-server')],
        },
      ]),
      getHealthStates: vi.fn().mockReturnValue({
        'offline-server': DownstreamHealth.Offline,
      }),
    }

    const engine = new TriggerEngine(store, registry as never, selector as never)
    await engine.evaluate(SessionIdSchema.parse('session-1'), outcome)

    expect(selector.select).toHaveBeenCalledOnce()
    const selectorInput = vi.mocked(selector.select).mock.calls[0]?.[0]
    expect(selectorInput?.healthStates).toEqual({ 'offline-server': DownstreamHealth.Offline })
    expect(selectorInput?.candidates.map((tool) => tool.serverId)).toEqual(['gmail-server'])
  })
})
