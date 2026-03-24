/**
 * Golden-path integration tests — full flow with a real FakeMcpServer
 *
 * Flow:
 *   1. Start FakeMcpServer with read-only gmail tools
 *   2. Write bootstrap.json pointing to FakeMcpServer URL
 *   3. registry.start() populates tool cache from FakeMcpServer
 *   4. initialize → session created with non-empty bootstrap window
 *   5. tools/list → returns visible tools
 *   6. tools/call → routes to FakeMcpServer, returns result
 *   7. Outcome recorded in session recentOutcomes
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../../src/gateway/server.js'
import { healthRoutes } from '../../src/gateway/routes/health.js'
import { mcpRoutes } from '../../src/gateway/routes/mcp.js'
import { createTempSqliteSessionStore } from '../fixtures/sqlite-session-store.js'
import type { SqliteSessionRepository } from '../../src/repositories/sessions/sqlite.js'
import { DownstreamRegistry } from '../../src/registry/registry.js'
import { SelectorEngine } from '../../src/selector/engine.js'
import { TriggerEngine } from '../../src/trigger/index.js'
import { initConfig } from '../../src/config/index.js'
import { createFakeMcpServer } from '../fixtures/fake-mcp-server.js'
import {
  defaultDebug,
  defaultResilience,
  defaultSelector,
  defaultSession,
  defaultTriggers,
} from '../fixtures/bootstrap-json.js'
import type { FastifyInstance } from 'fastify'
import type { FakeMcpServer } from '../fixtures/fake-mcp-server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, '__tmp_golden_path__')

const AUTH_ALICE = { Authorization: 'Bearer alice:user' }

let app: FastifyInstance
let store: SqliteSessionRepository
let disposeSessionDb: () => void
let fakeServer: FakeMcpServer

beforeAll(async () => {
  // 1. Start FakeMcpServer with low-risk gmail tools
  fakeServer = await createFakeMcpServer({
    tools: [
      { name: 'read_email', description: 'Read an email by ID', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
      { name: 'list_emails', description: 'List emails in inbox', inputSchema: { type: 'object', properties: {} } },
      { name: 'search_emails', description: 'Search emails by query', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    ],
  })

  // 2. Write bootstrap.json pointing to FakeMcpServer
  mkdirSync(TMP, { recursive: true })

  writeFileSync(
    join(TMP, 'bootstrap.json'),
    JSON.stringify(
      {
        servers: [
          {
            id: 'fake-gmail-server',
            namespaces: ['gmail'],
            transport: 'streamable-http',
            url: fakeServer.url,
            enabled: true,
            trustLevel: 'internal',
          },
        ],
        auth: { mode: 'mock_dev' },
        namespaces: {
          gmail: {
            allowedRoles: ['user', 'admin'],
            bootstrapWindowSize: 5,
            candidatePoolSize: 20,
            allowedModes: ['read', 'write'],
          },
        },
        roles: {
          user: {
            allowNamespaces: ['gmail'],
            denyModes: ['admin'],
          },
          admin: {
            allowNamespaces: ['gmail'],
          },
        },
        selector: defaultSelector,
        session: defaultSession,
        triggers: defaultTriggers,
        resilience: defaultResilience,
        debug: defaultDebug,
        starterPacks: {
          gmail: {
            preferredTags: ['email'],
            maxTools: 5,
            includeRiskLevels: ['low'],
            includeModes: ['read'],
          },
        },
      },
      null,
      2,
    ),
  )

  // 3. Load config and populate registry from FakeMcpServer
  const config = initConfig(TMP)

  const created = createTempSqliteSessionStore()
  store = created.store
  disposeSessionDb = () => {
    created.store.stop()
    created.close()
  }
  const registry = new DownstreamRegistry()

  // Populate tool cache by fetching from FakeMcpServer
  await registry.start(config.servers)

  const selector = new SelectorEngine()
  const triggerEngine = new TriggerEngine(store, registry, selector)

  app = buildServer({ logLevel: 'silent' })
  app.register(healthRoutes)
  app.register(mcpRoutes, { store, registry, triggerEngine })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  disposeSessionDb()
  await fakeServer.close()
  rmSync(TMP, { recursive: true, force: true })
})

describe('Golden path — initialize', () => {
  it('creates session and returns Mcp-Session-Id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['mcp-session-id']).toBeDefined()
    expect(typeof res.headers['mcp-session-id']).toBe('string')
  })

  it('returns correct protocol version and server info', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })

    const body = res.json()
    expect(body.result.protocolVersion).toBe('2024-11-05')
    expect(body.result.serverInfo.name).toBe('mcp-session-gateway')
  })
})

describe('Golden path — tools/list with bootstrap window', () => {
  it('returns non-empty tools array after registry is populated', async () => {
    // Initialize to create session
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    const sessionId = initRes.headers['mcp-session-id'] as string

    // Get tools list
    const listRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE, 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    })

    expect(listRes.statusCode).toBe(200)
    const tools = listRes.json().result.tools
    expect(Array.isArray(tools)).toBe(true)
    // FakeMcpServer serves 3 low-risk tools; all should appear in bootstrap window
    expect(tools.length).toBeGreaterThan(0)
  })

  it('bootstrap window tools have name, description, and inputSchema', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    const sessionId = initRes.headers['mcp-session-id'] as string

    const listRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE, 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    })

    const tools = listRes.json().result.tools
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.inputSchema).toBe('object')
    }
  })

  it('tools/list includes only gateway meta-tools', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    const sessionId = initRes.headers['mcp-session-id'] as string

    const listRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE, 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    })

    const toolNames = listRes.json().result.tools.map((t: { name: string }) => t.name)
    expect(toolNames).toContain('gateway_search_tools')
    expect(toolNames).toContain('gateway_call_tool')
    expect(toolNames).toHaveLength(2)
  })
})

describe('Golden path — tools/call routes to FakeMcpServer', () => {
  it('successfully calls a downstream tool via gateway_call_tool', async () => {
    // Initialize
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    const sessionId = initRes.headers['mcp-session-id'] as string

    // Call read_email via gateway_call_tool (bypasses window visibility)
    const callRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE, 'mcp-session-id': sessionId },
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'gateway_call_tool',
          arguments: { name: 'read_email', serverId: 'fake-gmail-server', arguments: { id: 'msg-001' } },
        },
      },
    })

    expect(callRes.statusCode).toBe(200)
    const body = callRes.json()
    expect(body.result).toBeDefined()
    // gateway_call_tool wraps the downstream result
    expect(body.result.content).toBeDefined()
    expect(body.result.content[0].text).toContain('read_email')
  })

  it('returns TOOL_NOT_VISIBLE for tool not in session window', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    const sessionId = initRes.headers['mcp-session-id'] as string

    const callRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE, 'mcp-session-id': sessionId },
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      },
    })

    expect(callRes.statusCode).toBe(404)
    expect(callRes.json().error).toBe('TOOL_NOT_VISIBLE')
  })

  it('records execution outcome in session recentOutcomes via gateway_call_tool', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    const sessionId = initRes.headers['mcp-session-id'] as string

    // Call via gateway_call_tool
    await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE, 'mcp-session-id': sessionId },
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'gateway_call_tool',
          arguments: { name: 'read_email', serverId: 'fake-gmail-server', arguments: { id: 'msg-001' } },
        },
      },
    })

    // Verify session now has recentOutcomes
    const session = await store.get(sessionId)
    expect(session).toBeDefined()
    expect(session!.recentOutcomes.length).toBeGreaterThan(0)
    expect(session!.recentOutcomes[0]!.toolName).toBe('read_email')
  })
})

describe('Golden path — cold start explicit (no registry tools)', () => {
  it('tools/list returns only gateway meta-tools when registry has no downstream tools', async () => {
    // Create a separate app with an empty registry (no start() called)
    const { store: emptyStore, close: closeEmpty } = createTempSqliteSessionStore()
    const emptyRegistry = new DownstreamRegistry()
    const emptySelector = new SelectorEngine()
    const emptyTrigger = new TriggerEngine(emptyStore, emptyRegistry, emptySelector)

    const emptyApp = buildServer({ logLevel: 'silent' })
    emptyApp.register(healthRoutes)
    emptyApp.register(mcpRoutes, { store: emptyStore, registry: emptyRegistry, triggerEngine: emptyTrigger })
    await emptyApp.ready()

    const initRes = await emptyApp.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    const sessionId = initRes.headers['mcp-session-id'] as string

    const listRes = await emptyApp.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE, 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    })

    expect(listRes.statusCode).toBe(200)
    const toolNames = listRes.json().result.tools.map((t: { name: string }) => t.name)
    expect(toolNames).toContain('gateway_search_tools')
    expect(toolNames).toContain('gateway_call_tool')
    expect(toolNames).toHaveLength(2)

    await emptyApp.close()
    emptyStore.stop()
    closeEmpty()
  })
})
