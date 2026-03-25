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
      expect(result.backend).toBe('vm')
      expect(result.value).toBe(2)
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

      expect(result.backend).toBe('vm')
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
      // This test exposes the race condition bug in sandbox.ts:139-143
      // The VM timeout and Promise.race timeout don't coordinate properly
      // If the test hangs, the bug exists (timeout not being respected)
      const session = makeSession()
      const registry = {
        getToolsByNamespace: vi.fn().mockReturnValue([]),
      }

      // Use Promise.race to enforce test timeout since the bug may cause infinite hang
      const result = await Promise.race([
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
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('TEST TIMEOUT: executeCodeMode hung - bug exists')),
            500
          )
        ),
      ])

      // Should return an error result, not an empty object or crash
      expect(result).toBeDefined()
      if (typeof result === 'object' && result !== null) {
        const r = result as Record<string, unknown>
        expect(r.backend).toBe('vm')
        // Bug: value might be undefined or missing due to race condition
        // Expected: should have an error property or throw
        if ('error' in r) {
          expect(r.error).toContain('timeout')
        } else if (!('value' in r) || r.value === undefined) {
          // This is the bug - no error and no value
          throw new Error('BUG: Timeout returned undefined value instead of error')
        }
      }
    })

    it('should return timeout error for blocking synchronous code', async () => {
      const session = makeSession()
      const registry = {
        getToolsByNamespace: vi.fn().mockReturnValue([]),
      }

      // Use Promise.race to enforce test timeout
      const result = await Promise.race([
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
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('TEST TIMEOUT: executeCodeMode hung - bug exists')),
            500
          )
        ),
      ])

      // Should have meaningful error handling, not just silent failure
      expect(result).toBeDefined()
      if (typeof result === 'object' && result !== null) {
        const r = result as Record<string, unknown>
        if ('error' in r) {
          expect(typeof r.error === 'string' || r.error instanceof Error).toBe(true)
        } else {
          // Bug check: if no error property, must have value
          if (!('value' in r)) {
            throw new Error('BUG: Synchronous timeout produced neither value nor error')
          }
        }
      }
    })
  })
})
