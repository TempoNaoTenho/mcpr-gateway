import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleToolsCall } from '../../src/gateway/dispatch/tools-call.js'
import type { McpHandlerContext } from '../../src/gateway/mcp-handler-context.js'
import { createTempSqliteSessionStore } from '../fixtures/sqlite-session-store.js'
import { Mode, OutcomeClass, SessionStatus } from '../../src/types/enums.js'
import { GatewayError } from '../../src/types/errors.js'
import { SessionIdSchema } from '../../src/types/identity.js'
import type { SessionState } from '../../src/types/session.js'
import type { TriggerEngine } from '../../src/trigger/index.js'

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

describe('handleToolsCall', () => {
  let disposeStore: (() => void) | undefined
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
})
