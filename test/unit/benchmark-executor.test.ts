import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runE2ECase, runRetrievalCase } from '../../bench/lib/executor.js'
import { getConfig, initConfig, setConfig } from '../../src/config/index.js'
import { GatewayMode, Mode, SourceTrustLevel } from '../../src/types/enums.js'
import type { DownstreamRegistry } from '../../src/registry/registry.js'
import type { BenchmarkScenario } from '../../bench/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, '__tmp_benchmark_executor__')

function writeMinimalBootstrap(): void {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(join(TMP, 'bootstrap.json'), JSON.stringify({
    servers: [],
    auth: { mode: 'static_key' },
    namespaces: {
      default: {
        allowedRoles: ['user'],
        bootstrapWindowSize: 4,
        candidatePoolSize: 16,
        allowedModes: ['read'],
        gatewayMode: 'default',
      },
    },
    roles: {
      user: {
        allowNamespaces: ['default'],
        denyModes: ['admin'],
      },
    },
    selector: {
      lexical: { enabled: true },
      penalties: { write: 0.2, admin: 0.5, unhealthyDownstream: 0.7 },
    },
    session: { ttlSeconds: 1800, cleanupIntervalSeconds: 60, handleTtlSeconds: 300 },
    triggers: {
      refreshOnSuccess: false,
      refreshOnTimeout: true,
      refreshOnError: true,
      replaceOrAppend: 'replace',
      cooldownSeconds: 30,
    },
    resilience: {
      timeouts: { connectMs: 5000, responseMs: 10000, totalMs: 30000 },
      rateLimit: {
        perSession: { maxRequests: 100, windowSeconds: 60 },
        perUser: { maxRequests: 500, windowSeconds: 60 },
        perDownstreamConcurrency: 10,
      },
      circuitBreaker: {
        degradedAfterFailures: 3,
        offlineAfterFailures: 5,
        resetAfterSeconds: 60,
      },
    },
    debug: { enabled: false },
    codeMode: {
      memoryLimitMb: 128,
      executionTimeoutMs: 10_000,
      maxToolCallsPerExecution: 20,
      maxResultSizeBytes: 1_048_576,
      artifactStoreTtlSeconds: 300,
      maxConcurrentToolCalls: 5,
    },
    starterPacks: {
      default: {
        preferredTags: ['search'],
        maxTools: 4,
        includeRiskLevels: ['low'],
        includeModes: ['read'],
      },
    },
    allowedOAuthProviders: [],
  }, null, 2))
}

function makeScenario(namespace: string): BenchmarkScenario {
  return {
    id: `${namespace}-scenario`,
    namespace,
    prompt: 'Find the right tool',
    expectedTools: ['docs_search'],
    expectedServerIds: ['docs'],
    discoveryQuery: 'docs search',
    mode: Mode.Read,
    authHeader: 'Bearer bench-token',
  }
}

function makeRegistry(hasTools: boolean): DownstreamRegistry {
  const records = hasTools ? [{
    name: 'docs_search',
    description: 'Search documentation',
    inputSchema: { type: 'object', properties: {} },
    serverId: 'docs',
    namespace: 'default',
    retrievedAt: new Date().toISOString(),
    sanitized: false,
  }] : []

  return {
    getToolsByNamespace(namespace: string) {
      if (namespace !== 'default') return []
      return [{
        server: {
          id: 'docs',
          transport: 'stdio',
          command: 'echo',
          args: [],
          env: {},
          namespaces: ['default'],
          trustLevel: SourceTrustLevel.Verified,
        },
        records,
      }]
    },
    getHealthStates() {
      return new Map()
    },
  } as unknown as DownstreamRegistry
}

describe('benchmark executor', () => {
  let previousConfig = {} as ReturnType<typeof getConfig>

  beforeAll(() => {
    writeMinimalBootstrap()
    initConfig(TMP)
    previousConfig = getConfig()
  })

  afterEach(() => {
    setConfig(previousConfig)
  })

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it('skips compat retrieval flow for non-compat namespaces', async () => {
    setConfig({
      ...previousConfig,
      auth: {
        ...previousConfig.auth,
        staticKeys: {
          ...(previousConfig.auth.staticKeys ?? {}),
          'bench-token': {
            userId: 'bench-user',
            roles: ['user'],
          },
        },
      },
      namespaces: {
        ...previousConfig.namespaces,
        default: {
          ...previousConfig.namespaces.default,
          allowedRoles: ['user'],
          allowedModes: [Mode.Read],
          gatewayMode: GatewayMode.Default,
        },
      },
      roles: {
        ...previousConfig.roles,
        user: {
          ...(previousConfig.roles.user ?? { denyModes: [] }),
          allowNamespaces: ['default'],
        },
      },
    })

    const client = {
      initialize: async () => ({ sessionId: 's1' }),
      toolsList: async () => [],
      callTool: async () => {
        throw new Error('gateway_search_tools should not be called for default mode namespaces')
      },
    } as any

    const result = await runRetrievalCase(client, makeRegistry(true), makeScenario('default'))

    expect(result.gateway.searchUsed).toBe(false)
    expect(result.gateway.rank).toBeNull()
    expect(result.baseline.visibleToolCount).toBe(1)
  })

  it('skips compat e2e flow for non-compat namespaces', async () => {
    setConfig({
      ...previousConfig,
      auth: {
        ...previousConfig.auth,
        staticKeys: {
          ...(previousConfig.auth.staticKeys ?? {}),
          'bench-token': {
            userId: 'bench-user',
            roles: ['user'],
          },
        },
      },
      namespaces: {
        ...previousConfig.namespaces,
        default: {
          ...previousConfig.namespaces.default,
          allowedRoles: ['user'],
          allowedModes: [Mode.Read],
          gatewayMode: GatewayMode.Default,
        },
      },
      roles: {
        ...previousConfig.roles,
        user: {
          ...(previousConfig.roles.user ?? { denyModes: [] }),
          allowNamespaces: ['default'],
        },
      },
    })

    const client = {
      initialize: async () => ({ sessionId: 's1' }),
      toolsList: async () => [],
      callTool: async () => {
        throw new Error('gateway_search_tools should not be called for default mode namespaces')
      },
    } as any

    const result = await runE2ECase(client, makeRegistry(false), makeScenario('default'))

    expect(result.gateway.searchUsed).toBe(false)
    expect(result.gateway.error).toContain('Skipped compat gateway flow')
    expect(result.baseline.error).toBe('No baseline tool selected')
  })
})
