import { describe, expect, it } from 'vitest'
import { generateDatasetFromRegistry } from '../../bench/lib/local-dataset.js'
import { GatewayMode, Mode, ToolRiskLevel } from '../../src/types/enums.js'
import type { GatewayConfig } from '../../src/config/index.js'
import type { DownstreamRegistry } from '../../src/registry/registry.js'

function makeConfig(): GatewayConfig {
  return {
    servers: [],
    auth: { mode: 'static_key', staticKeys: {} },
    namespaces: {
      alpha: {
        allowedRoles: ['user'],
        bootstrapWindowSize: 4,
        candidatePoolSize: 8,
        allowedModes: [Mode.Read],
        gatewayMode: GatewayMode.Compat,
        disabledTools: [],
      },
      beta: {
        allowedRoles: ['user'],
        bootstrapWindowSize: 4,
        candidatePoolSize: 8,
        allowedModes: [Mode.Read],
        gatewayMode: GatewayMode.Default,
        disabledTools: [],
      },
    },
    roles: {
      user: {
        allowNamespaces: ['alpha', 'beta'],
      },
    },
    selector: {
      lexical: { enabled: false },
      penalties: { write: 0, admin: 0.35, unhealthyDownstream: 0.5 },
      focus: { enabled: false, lookback: 5, minDominantSuccesses: 2, reserveSlots: 1, crossDomainPenalty: 1 },
      publication: {
        descriptionCompression: 'off',
        schemaCompression: 'off',
        descriptionMaxLength: 0,
      },
    },
    session: {
      ttlSeconds: 1800,
      cleanupIntervalSeconds: 60,
      handleTtlSeconds: 300,
    },
    triggers: {
      refreshOnSuccess: false,
      refreshOnTimeout: true,
      refreshOnError: true,
      replaceOrAppend: 'replace',
      cooldownSeconds: 30,
    },
    resilience: {
      timeouts: { connectMs: 5000, responseMs: 10000, totalMs: 30000 },
      limits: {
        perSession: { maxRequests: 100, windowSeconds: 60 },
        global: { maxRequests: 500, windowSeconds: 60 },
        perDownstreamConcurrency: 10,
      },
      health: { degradedAfterFailures: 3, offlineAfterFailures: 5, resetAfterSeconds: 60 },
    },
    debug: { enabled: false },
    codeMode: {
      enabled: false,
      memoryLimitMb: 128,
      executionTimeoutMs: 10_000,
      maxToolCallsPerExecution: 20,
      maxResultSizeBytes: 1_048_576,
      artifactStoreTtlSeconds: 300,
      maxConcurrentToolCalls: 5,
    },
    starterPacks: {},
    allowedOAuthProviders: [],
  }
}

function makeRegistry(): Pick<DownstreamRegistry, 'getToolsByNamespace' | 'getHealthState'> {
  return {
    getToolsByNamespace(namespace: string) {
      if (namespace === 'alpha') {
        return [{
          server: {
            id: 'server-a',
            transport: 'streamable-http',
            url: 'https://example.com/mcp',
            namespaces: ['alpha'],
            enabled: true,
            toolOverrides: {},
          },
          records: [
            {
              name: 'search_docs',
              description: 'Search project docs',
              inputSchema: { type: 'object', required: [], properties: {} },
              namespace,
              riskLevel: ToolRiskLevel.Low,
              tags: [],
            },
            {
              name: 'write_file',
              description: 'Write a file',
              inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
              namespace,
              riskLevel: ToolRiskLevel.Low,
              tags: [],
            },
          ],
        }]
      }

      if (namespace === 'beta') {
        return [{
          server: {
            id: 'server-b',
            transport: 'streamable-http',
            url: 'https://example.com/other',
            namespaces: ['beta'],
            enabled: true,
            toolOverrides: {},
          },
          records: [{
            name: 'list_tables',
            description: 'List database tables',
            inputSchema: { type: 'object', required: [], properties: {} },
            namespace,
            riskLevel: ToolRiskLevel.Low,
            tags: [],
          }],
        }]
      }

      return []
    },
    getHealthState() {
      return undefined
    },
  }
}

describe('generateDatasetFromRegistry', () => {
  it('filters namespaces, servers, and tools', () => {
    const result = generateDatasetFromRegistry(
      makeConfig(),
      makeRegistry() as DownstreamRegistry,
      {
        namespaces: ['alpha'],
        serverIds: ['server-a'],
        toolPattern: 'search',
        maxScenariosPerServer: 2,
      },
    )

    expect(result.dataset.scenarios).toHaveLength(1)
    expect(result.dataset.scenarios[0]?.namespace).toBe('alpha')
    expect(result.dataset.scenarios[0]?.expectedTools).toEqual(['search_docs'])
    expect(result.diagnostics.namespaces).toEqual([
      { name: 'alpha', serverCount: 1, toolCount: 1 },
    ])
  })
})
