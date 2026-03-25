import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeGatewaySearch } from '../../../src/gateway/discovery.js'
import { initConfig } from '../../../src/config/index.js'
import type { SessionState } from '../../../src/types/session.js'
import type { IRegistryAdapter } from '../../../src/types/interfaces.js'
import type { ToolRecord } from '../../../src/types/tools.js'
import { Mode, SourceTrustLevel, SessionStatus } from '../../../src/types/enums.js'
import {
  defaultDebug,
  defaultResilience,
  defaultSelector,
  defaultSession,
} from '../../fixtures/bootstrap-json.js'

const TMP = mkdtempSync(join(tmpdir(), 'mcp-session-gateway-discovery-'))

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

function writeConfig(): void {
  writeFileSync(
    join(TMP, 'bootstrap.json'),
    JSON.stringify(
      {
        servers: [
          {
            id: 'github-server',
            namespaces: ['default'],
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@example/github-mcp'],
            enabled: true,
            trustLevel: 'internal',
          },
        ],
        auth: { mode: 'static_key' },
        namespaces: {
          default: {
            allowedRoles: ['user'],
            bootstrapWindowSize: 4,
            candidatePoolSize: 8,
            allowedModes: ['read', 'write'],
          },
        },
        roles: {
          user: {
            allowNamespaces: ['default'],
          },
        },
        selector: defaultSelector,
        session: defaultSession,
        triggers: {
          refreshOnSuccess: false,
          refreshOnTimeout: true,
          refreshOnError: true,
          replaceOrAppend: 'replace' as const,
          cooldownSeconds: 0,
        },
        resilience: defaultResilience,
        debug: defaultDebug,
        starterPacks: {},
      },
      null,
      2
    )
  )
  initConfig(TMP)
}

function makeSession(namespace = 'default'): SessionState {
  return {
    id: 'sess-test',
    userId: 'user-1',
    namespace,
    mode: Mode.Read,
    status: SessionStatus.Active,
    toolWindow: [],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    refreshCount: 0,
    recentOutcomes: [],
    refreshHistory: [],
    pendingToolListChange: false,
    clientCapabilities: { supportsToolListChanged: false },
  }
}

function makeToolRecord(name: string, description: string): ToolRecord {
  return {
    name,
    description,
    inputSchema: { type: 'object' },
    serverId: 'github-server',
    namespace: 'default',
    retrievedAt: new Date().toISOString(),
    sanitized: true,
  }
}

function makeRegistry(tools: Array<{ name: string; description: string }>): IRegistryAdapter {
  return {
    getToolsByNamespace: vi.fn().mockReturnValue([
      {
        server: {
          serverId: 'github-server',
          name: 'GitHub',
          transport: { type: 'stdio' } as any,
          enabled: true,
          trustLevel: SourceTrustLevel.Verified,
          toolOverrides: {},
        },
        records: tools.map((t) => makeToolRecord(t.name, t.description)),
      },
    ]),
  } as unknown as IRegistryAdapter
}

describe('executeGatewaySearch quality signals', () => {
  let session: SessionState
  let registry: IRegistryAdapter

  beforeEach(() => {
    writeConfig()
    session = makeSession()
  })

  it('returns score field for each match', async () => {
    registry = makeRegistry([
      { name: 'list_issues', description: 'List all open issues' },
      { name: 'read_file', description: 'Read a file from disk' },
    ])

    const result = await executeGatewaySearch(session, { query: 'issues', limit: 5 }, registry)
    const { result: body } = result as {
      result: { query: string; matches: Array<Record<string, unknown>> }
    }

    expect(body.matches.length).toBeGreaterThan(0)
    for (const match of body.matches) {
      expect(match).toHaveProperty('score')
      expect(typeof match.score).toBe('number')
      expect(match.score).toBeGreaterThanOrEqual(0)
    }
  })

  it('returns matchedTerms field for each match', async () => {
    registry = makeRegistry([
      { name: 'list_issues', description: 'List all open issues' },
      { name: 'create_pr', description: 'Create a pull request' },
    ])

    const result = await executeGatewaySearch(
      session,
      { query: 'github issues', limit: 5 },
      registry
    )
    const { result: body } = result as {
      result: { query: string; matches: Array<Record<string, unknown>> }
    }

    expect(body.matches.length).toBeGreaterThan(0)
    for (const match of body.matches) {
      expect(match).toHaveProperty('matchedTerms')
      expect(Array.isArray(match.matchedTerms)).toBe(true)
    }
  })

  it('higher score means more relevant results first', async () => {
    registry = makeRegistry([
      { name: 'read_file', description: 'Read a file from disk' },
      { name: 'list_issues', description: 'List all open issues' },
      { name: 'search_issues', description: 'Search for issues by keyword' },
    ])

    const result = await executeGatewaySearch(session, { query: 'issues', limit: 5 }, registry)
    const { result: body } = result as {
      result: { query: string; matches: Array<{ score: number }> }
    }

    if (body.matches.length > 1) {
      for (let i = 1; i < body.matches.length; i++) {
        expect(body.matches[i - 1].score).toBeGreaterThanOrEqual(body.matches[i].score)
      }
    }
  })

  it('matchedTerms contains terms from query', async () => {
    registry = makeRegistry([
      { name: 'list_issues', description: 'List all open issues' },
      { name: 'create_pr', description: 'Create a pull request' },
    ])

    const result = await executeGatewaySearch(session, { query: 'github pr', limit: 5 }, registry)
    const { result: body } = result as {
      result: { query: string; matches: Array<Record<string, unknown>> }
    }

    const matchedAny = body.matches.some((match) => {
      const terms = match.matchedTerms as string[]
      return terms.some(
        (term) => term.toLowerCase().includes('github') || term.toLowerCase().includes('pr')
      )
    })

    expect(matchedAny).toBe(true)
  })

  it('backward compatible - existing fields present', async () => {
    registry = makeRegistry([{ name: 'list_issues', description: 'List all open issues' }])

    const result = await executeGatewaySearch(session, { query: 'issues', limit: 5 }, registry)
    const { result: body } = result as {
      result: { query: string; matches: Array<Record<string, unknown>> }
    }

    expect(body).toHaveProperty('query')
    expect(body).toHaveProperty('matches')
    expect(Array.isArray(body.matches)).toBe(true)

    const match = body.matches[0]
    expect(match).toHaveProperty('name')
    expect(typeof match.name).toBe('string')

    expect(match).toHaveProperty('serverId')
    expect(typeof match.serverId).toBe('string')

    expect(match).toHaveProperty('description')
    expect(typeof match.description).toBe('string')
  })

  it('returns empty matches for non-matching query', async () => {
    registry = makeRegistry([{ name: 'list_issues', description: 'List all open issues' }])

    const result = await executeGatewaySearch(
      session,
      { query: 'xyznonexistent123', limit: 5 },
      registry
    )
    const { result: body } = result as {
      result: { query: string; matches: Array<Record<string, unknown>> }
    }

    expect(body.matches).toHaveLength(0)
  })

  it('respects limit parameter', async () => {
    registry = makeRegistry([
      { name: 'list_issues', description: 'List issues' },
      { name: 'create_issue', description: 'Create an issue' },
      { name: 'search_issues', description: 'Search issues' },
      { name: 'close_issue', description: 'Close an issue' },
      { name: 'reopen_issue', description: 'Reopen an issue' },
    ])

    const result = await executeGatewaySearch(session, { query: 'issue', limit: 3 }, registry)
    const { result: body } = result as {
      result: { query: string; matches: Array<Record<string, unknown>> }
    }

    expect(body.matches.length).toBeLessThanOrEqual(3)
  })
})
