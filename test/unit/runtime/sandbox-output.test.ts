import { describe, expect, it, vi, beforeEach } from 'vitest'
import { setConfig } from '../../../src/config/index.js'
import { executeCodeMode } from '../../../src/runtime/index.js'
import { artifactStore } from '../../../src/runtime/artifact-store.js'
import { GatewayMode, Mode, SessionStatus } from '../../../src/types/enums.js'
import { SessionIdSchema } from '../../../src/types/identity.js'
import type { SessionState } from '../../../src/types/session.js'
import {
  defaultDebug,
  defaultResilience,
  defaultSelector,
  defaultSession,
  defaultTriggers,
} from '../../fixtures/bootstrap-json.js'

function makeSession(): SessionState {
  const now = new Date().toISOString()
  return {
    id: SessionIdSchema.parse('session-sandbox-output'),
    userId: 'user-sandbox',
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
    },
    starterPacks: {},
  })
})

describe('sandbox output bugs', () => {
  describe('AC1: gateway_run_code returns actual result, not just backend', () => {
    it('should return actual result value from simple code execution', async () => {
      const session = makeSession()
      const registry = {
        getToolsByNamespace: vi.fn().mockReturnValue([]),
      }

      // Execute code that returns a simple value
      const result = (await executeCodeMode(
        'return 1 + 1',
        session,
        registry as never,
        {
          memoryLimitMb: 128,
          executionTimeoutMs: 5_000,
          maxToolCallsPerExecution: 10,
          maxResultSizeBytes: 8_192,
          artifactStoreTtlSeconds: 300,
        },
        vi.fn()
      )) as { backend: string; value: unknown }

      // The result should contain the actual computed value, not just backend info
      expect(result.backend).toBe('isolated-vm')
      expect(result.value).toBe(2)
    })

    it('should accept bare expressions without return for LLM-friendly usage', async () => {
      const session = makeSession()
      const registry = {
        getToolsByNamespace: vi.fn().mockReturnValue([]),
      }

      const result = (await executeCodeMode(
        '1 + 1',
        session,
        registry as never,
        {
          memoryLimitMb: 128,
          executionTimeoutMs: 5_000,
          maxToolCallsPerExecution: 10,
          maxResultSizeBytes: 8_192,
          artifactStoreTtlSeconds: 300,
        },
        vi.fn()
      )) as { backend: string; value: unknown }

      expect(result.backend).toBe('isolated-vm')
      expect(result.value).toBe(2)
    })

    it('should accept statement snippets with explicit return', async () => {
      const session = makeSession()
      const registry = {
        getToolsByNamespace: vi.fn().mockReturnValue([]),
      }

      const result = (await executeCodeMode(
        'return 40 + 2',
        session,
        registry as never,
        {
          memoryLimitMb: 128,
          executionTimeoutMs: 5_000,
          maxToolCallsPerExecution: 10,
          maxResultSizeBytes: 8_192,
          artifactStoreTtlSeconds: 300,
        },
        vi.fn()
      )) as { backend: string; value: unknown }

      expect(result.backend).toBe('isolated-vm')
      expect(result.value).toBe(42)
    })

    it('should return actual result from code with array operations', async () => {
      const session = makeSession()
      const registry = {
        getToolsByNamespace: vi.fn().mockReturnValue([]),
      }

      const result = (await executeCodeMode(
        'return [1, 2, 3].map(x => x * 2)',
        session,
        registry as never,
        {
          memoryLimitMb: 128,
          executionTimeoutMs: 5_000,
          maxToolCallsPerExecution: 10,
          maxResultSizeBytes: 8_192,
          artifactStoreTtlSeconds: 300,
        },
        vi.fn()
      )) as { backend: string; value: unknown }

      expect(result.backend).toBe('isolated-vm')
      expect(result.value).toEqual([2, 4, 6])
    })
  })

  describe('AC2: artifactStore.save() errors should be handled gracefully', () => {
    it('should return error when artifact store save fails', async () => {
      const session = makeSession()
      const registry = {
        getToolsByNamespace: vi.fn().mockReturnValue([]),
      }

      // Mock artifactStore.save to throw an error
      vi.spyOn(artifactStore, 'save').mockImplementation(() => {
        throw new Error('Artifact store unavailable')
      })

      try {
        // Execute code with small maxResultSizeBytes to force artifact storage path
        await expect(
          executeCodeMode(
            'return Array.from({ length: 25 }, (_, i) => ({ i, data: "x".repeat(120) }))',
            session,
            registry as never,
            {
              memoryLimitMb: 128,
              executionTimeoutMs: 5_000,
              maxToolCallsPerExecution: 10,
              maxResultSizeBytes: 256, // Force artifact storage path
              artifactStoreTtlSeconds: 300,
            },
            vi.fn()
          )
        ).rejects.toThrow('Artifact store unavailable')
      } finally {
        vi.restoreAllMocks()
      }
    })

    it('should not crash when artifact store returns unexpected value', async () => {
      const session = makeSession()
      const registry = {
        getToolsByNamespace: vi.fn().mockReturnValue([]),
      }

      // Mock artifactStore.save to return a non-standard value (missing expected properties)
      vi.spyOn(artifactStore, 'save').mockReturnValue('not-an-object' as never)

      try {
        const result = await executeCodeMode(
          'return Array.from({ length: 25 }, (_, i) => ({ i, data: "x".repeat(120) }))',
          session,
          registry as never,
          {
            memoryLimitMb: 128,
            executionTimeoutMs: 5_000,
            maxToolCallsPerExecution: 10,
            maxResultSizeBytes: 256,
            artifactStoreTtlSeconds: 300,
          },
          vi.fn()
        )

        // Should either succeed with the artifact ref or throw a meaningful error
        // Should NOT return undefined properties like artifactRef: undefined
        if (typeof result === 'object' && result !== null && 'artifactRef' in result) {
          expect(result.artifactRef).toBeDefined()
        }
      } finally {
        vi.restoreAllMocks()
      }
    })
  })

  describe('AC3: VM timeout should return proper error', () => {
    it('should return timeout error for infinite loop code', async () => {
      const session = makeSession()
      const registry = {
        getToolsByNamespace: vi.fn().mockReturnValue([]),
      }

      await expect(
        executeCodeMode(
          'while(true) {}',
          session,
          registry as never,
          {
            memoryLimitMb: 128,
            executionTimeoutMs: 100,
            maxToolCallsPerExecution: 10,
            maxResultSizeBytes: 8_192,
            artifactStoreTtlSeconds: 300,
          },
          vi.fn()
        )
      ).rejects.toThrow('Script execution timed out.')
    })

    it('should return timeout error for blocking synchronous code', async () => {
      const session = makeSession()
      const registry = {
        getToolsByNamespace: vi.fn().mockReturnValue([]),
      }

      await expect(
        executeCodeMode(
          'const start = Date.now(); while(Date.now() - start < 10000) {}; return "done"',
          session,
          registry as never,
          {
            memoryLimitMb: 128,
            executionTimeoutMs: 100,
            maxToolCallsPerExecution: 10,
            maxResultSizeBytes: 8_192,
            artifactStoreTtlSeconds: 300,
          },
          vi.fn()
        )
      ).rejects.toThrow('Script execution timed out.')
    })
  })

  describe('AC4: code-mode errors should be actionable for LLM usage', () => {
    it('should explain that result is a reserved global', async () => {
      const session = makeSession()
      const registry = {
        getToolsByNamespace: vi.fn().mockReturnValue([]),
      }

      await expect(
        executeCodeMode(
          'const result = 1; return result',
          session,
          registry as never,
          {
            memoryLimitMb: 128,
            executionTimeoutMs: 5_000,
            maxToolCallsPerExecution: 10,
            maxResultSizeBytes: 8_192,
            artifactStoreTtlSeconds: 300,
          },
          vi.fn()
        )
      ).rejects.toThrow('`result` is reserved in code mode')
    })

    it('should surface a bridge timeout with the operation name', async () => {
      const session = makeSession()
      const registry = {
        getToolsByNamespace: vi.fn().mockReturnValue([
          {
            server: {
              id: 'github-main',
              namespaces: ['github'],
              transport: 'http',
              url: 'https://example.com/mcp',
              enabled: true,
              trustLevel: 'internal',
            },
            records: [
              {
                name: 'slow_tool',
                description: 'Never resolves',
                inputSchema: { type: 'object', properties: {} },
                serverId: 'github-main',
                namespace: 'github',
                retrievedAt: new Date().toISOString(),
                sanitized: true,
              },
            ],
          },
        ]),
      }

      await expect(
        executeCodeMode(
          `
          const tools = await catalog.search("slow tool", { k: 1 })
          return await mcp.call(tools[0].handle, {})
          `,
          session,
          registry as never,
          {
            memoryLimitMb: 128,
            executionTimeoutMs: 80,
            maxToolCallsPerExecution: 10,
            maxResultSizeBytes: 8_192,
            artifactStoreTtlSeconds: 300,
          },
          () => new Promise(() => undefined)
        )
      ).rejects.toThrow('Bridge operation mcp.call timed out')
    })
  })
})
