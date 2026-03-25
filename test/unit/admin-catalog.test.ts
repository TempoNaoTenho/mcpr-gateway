import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAdminToolEntry } from '../../src/admin/catalog.js'
import { getConfig, initConfig, setConfig } from '../../src/config/index.js'
import { SourceTrustLevel } from '../../src/types/enums.js'
import type { DownstreamServer } from '../../src/types/server.js'
import type { ToolRecord } from '../../src/types/tools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, '__tmp_admin_catalog__')

const RESILIENCE = {
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
} as const

const SESSION = { ttlSeconds: 1800, cleanupIntervalSeconds: 60, handleTtlSeconds: 300 } as const

const TRIGGERS = {
  refreshOnSuccess: false,
  refreshOnTimeout: true,
  refreshOnError: true,
  replaceOrAppend: 'replace' as const,
  cooldownSeconds: 30,
}

function writeMinimalBootstrap(): void {
  const data = {
    servers: [
      {
        id: 'test-server',
        namespaces: ['test'],
        transport: 'streamable-http' as const,
        url: 'https://example.com/mcp',
        enabled: true,
        trustLevel: 'internal' as const,
      },
    ],
    auth: { mode: 'static_key' as const },
    namespaces: {
      test: {
        allowedRoles: ['user'],
        bootstrapWindowSize: 4,
        candidatePoolSize: 16,
        allowedModes: ['read' as const],
      },
    },
    roles: {
      user: {
        allowNamespaces: ['test'],
        denyModes: ['admin' as const],
      },
    },
    selector: {
      lexical: { enabled: true },
      penalties: { write: 0.2, admin: 0.5, unhealthyDownstream: 0.7 },
    },
    session: SESSION,
    triggers: TRIGGERS,
    resilience: RESILIENCE,
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
      test: {
        preferredTags: ['search'],
        maxTools: 4,
        includeRiskLevels: ['low' as const],
        includeModes: ['read' as const],
      },
    },
    allowedOAuthProviders: [],
  }
  mkdirSync(TMP, { recursive: true })
  writeFileSync(join(TMP, 'bootstrap.json'), JSON.stringify(data, null, 2))
}

const server: DownstreamServer = {
  id: 'test-server',
  transport: 'stdio',
  command: 'echo',
  args: [],
  env: {},
  namespaces: ['test'],
  trustLevel: SourceTrustLevel.Verified,
}

function makeRecord(description: string): ToolRecord {
  return {
    name: 'only.boilerplate',
    description,
    inputSchema: { type: 'object', properties: {} },
    serverId: 'test-server',
    namespace: 'test',
    retrievedAt: new Date().toISOString(),
    sanitized: false,
  }
}

describe('buildAdminToolEntry', () => {
  beforeEach(() => {
    writeMinimalBootstrap()
    initConfig(TMP)
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it('uses published description only when conservative compression removes all text', () => {
    const previous = getConfig()
    setConfig({
      ...previous,
      selector: {
        ...previous.selector,
        publication: {
          descriptionCompression: 'conservative',
          schemaCompression: 'off',
          descriptionMaxLength: 0,
        },
      },
    })
    try {
      const entry = buildAdminToolEntry(server, makeRecord('Use this tool to'))
      expect(entry.effectiveDescription).toBeUndefined()
    } finally {
      setConfig(previous)
    }
  })
})
