import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../../src/gateway/server.js'
import { healthRoutes } from '../../src/gateway/routes/health.js'
import { mcpRoutes } from '../../src/gateway/routes/mcp.js'
import { createTempSqliteSessionStore } from '../fixtures/sqlite-session-store.js'
import { DownstreamRegistry } from '../../src/registry/registry.js'
import { SelectorEngine } from '../../src/selector/engine.js'
import { TriggerEngine } from '../../src/trigger/index.js'
import { initConfig, setConfig } from '../../src/config/index.js'
import {
  defaultDebug,
  defaultResilience,
  defaultSelector,
  defaultSession,
  defaultTestStaticKeys,
  defaultTriggers,
} from '../fixtures/bootstrap-json.js'
import type { FastifyInstance } from 'fastify'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, '__tmp_mcp_config__')

const AUTH_USER = { Authorization: 'Bearer alice:user' }

let app: FastifyInstance
let disposeSessionDb: () => void
let registry: DownstreamRegistry

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
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
        auth: { mode: 'static_key' },
        namespaces: {
          gmail: {
            allowedRoles: ['user', 'admin'],
            bootstrapWindowSize: 4,
            candidatePoolSize: 16,
            allowedModes: ['read', 'write'],
          },
          dev: {
            allowedRoles: ['user'],
            bootstrapWindowSize: 4,
            candidatePoolSize: 16,
            allowedModes: ['read'],
          },
        },
        roles: {
          user: {
            allowNamespaces: ['gmail'],
            denyModes: ['admin'],
          },
          admin: {
            allowNamespaces: ['gmail', 'dev'],
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
            maxTools: 4,
            includeRiskLevels: ['low'],
            includeModes: ['read'],
          },
        },
      },
      null,
      2
    )
  )
  const config = initConfig(TMP)
  setConfig({
    ...config,
    auth: {
      ...config.auth,
      staticKeys: defaultTestStaticKeys,
    },
  })

  const { store, close } = createTempSqliteSessionStore()
  disposeSessionDb = () => {
    store.stop()
    close()
  }
  registry = new DownstreamRegistry()
  const selector = new SelectorEngine()
  const triggerEngine = new TriggerEngine(store, registry, selector)
  app = buildServer({ logLevel: 'silent' })
  app.register(healthRoutes)
  app.register(mcpRoutes, { store, registry, triggerEngine })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  registry?.stop()
  disposeSessionDb?.()
  rmSync(TMP, { recursive: true, force: true })
})

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})

describe('GET /healthz', () => {
  it('returns 200 with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})

describe('GET /readyz', () => {
  it('returns 200 with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})

describe('POST /mcp/gmail — initialize', () => {
  it('creates a session and returns Mcp-Session-Id header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['mcp-session-id']).toBeDefined()
    expect(res.headers['mcp-protocol-version']).toBe('2024-11-05')
    const body = res.json()
    expect(body.result.protocolVersion).toBe('2024-11-05')
    expect(body.result.serverInfo.name).toBe('mcpr-gateway')
  })

  it('negotiates Streamable HTTP protocol version when client requests 2025-06-18', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['mcp-protocol-version']).toBe('2025-06-18')
    expect(res.json().result.protocolVersion).toBe('2025-06-18')
  })

  it('exposes MCP session headers for loopback browser origins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:6274',
        ...AUTH_USER,
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:6274')
    expect(res.headers['access-control-expose-headers']).toBe(
      'Mcp-Session-Id, Mcp-Tools-Changed, MCP-Protocol-Version',
    )
    expect(res.headers['vary']).toBe('Origin')
  })

  it('advertises tools.listChanged support in server capabilities', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          capabilities: {
            tools: {
              listChanged: true,
            },
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().result.capabilities).toEqual({
      tools: {
        listChanged: true,
      },
    })
  })
})

describe('OPTIONS /mcp/gmail', () => {
  it('returns loopback CORS headers for browser preflight requests', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/mcp/gmail',
      headers: {
        Origin: 'http://localhost:6274',
        'Access-Control-Request-Method': 'POST',
      },
    })

    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:6274')
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS, DELETE')
    expect(res.headers['access-control-allow-headers']).toBe(
      'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version'
    )
    expect(res.headers['access-control-expose-headers']).toBe(
      'Mcp-Session-Id, Mcp-Tools-Changed, MCP-Protocol-Version',
    )
  })

  it('rejects non-loopback origins when browser allowlist is not configured', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/mcp/gmail',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
      },
    })

    expect(res.statusCode).toBe(403)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('GET /mcp/gmail', () => {
  it('opens a streamable HTTP SSE endpoint', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/mcp/gmail',
      headers: {
        Accept: 'text/event-stream',
        Origin: 'http://127.0.0.1:6274',
        ...AUTH_USER,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:6274')
    expect(res.body).toContain(': connected')
  })
})

describe('POST /mcp/gmail — tools/list', () => {
  it('returns only gateway meta-tools for valid session', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    const sessionId = initRes.headers['mcp-session-id'] as string

    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER, 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    })
    expect(res.statusCode).toBe(200)
    const toolNames = res.json().result.tools.map((t: { name: string }) => t.name)
    expect(toolNames).toContain('gateway_search_tools')
    expect(toolNames).toContain('gateway_call_tool')
    expect(toolNames).toHaveLength(2)
  })

  it('returns 404 SESSION_NOT_FOUND without Mcp-Session-Id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('SESSION_NOT_FOUND')
  })

  it('returns 404 SESSION_NOT_FOUND when session namespace differs from request namespace', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    const sessionId = initRes.headers['mcp-session-id'] as string

    const res = await app.inject({
      method: 'POST',
      url: '/mcp/dev',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER, 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('SESSION_NOT_FOUND')
  })

  it('returns 400 when MCP-Protocol-Version header disagrees with negotiated session', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
    })
    const sessionId = initRes.headers['mcp-session-id'] as string

    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: {
        'Content-Type': 'application/json',
        ...AUTH_USER,
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2024-11-05',
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('INVALID_MCP_PROTOCOL_VERSION')
  })
})

describe('POST /mcp/gmail — notifications', () => {
  it('accepts notifications/initialized without an id', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })

    const sessionId = initRes.headers['mcp-session-id'] as string
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER, 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    })

    expect(res.statusCode).toBe(202)
    expect(res.body).toBe('')
  })

  it('still rejects request methods without an id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: { jsonrpc: '2.0', method: 'tools/list', params: {} },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().message).toBe('Invalid JSON-RPC body')
  })
})

describe('POST /mcp/gmail — tools/call', () => {
  it('returns 404 TOOL_NOT_VISIBLE for valid session', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    const sessionId = initRes.headers['mcp-session-id'] as string

    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER, 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_email' } },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('TOOL_NOT_VISIBLE')
  })

  it('returns 404 SESSION_NOT_FOUND when session namespace differs from request namespace', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    const sessionId = initRes.headers['mcp-session-id'] as string

    const res = await app.inject({
      method: 'POST',
      url: '/mcp/dev',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER, 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_email' } },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('SESSION_NOT_FOUND')
  })
})

describe('POST /mcp/unknown — initialize', () => {
  it('returns 403 UNAUTHORIZED_NAMESPACE for unknown namespace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/unknown',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('UNAUTHORIZED_NAMESPACE')
  })
})

describe('POST /mcp/dev — initialize', () => {
  it('returns 403 UNAUTHORIZED_NAMESPACE when role allowNamespaces excludes the namespace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/dev',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('UNAUTHORIZED_NAMESPACE')
  })

  it('returns 403 UNAUTHORIZED_NAMESPACE when request has no matching bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('UNAUTHORIZED_NAMESPACE')
  })
})

describe('POST /mcp/gmail — unsupported method', () => {
  it('returns 501 UNSUPPORTED_OPERATION for unknown method', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_USER },
      payload: { jsonrpc: '2.0', id: 1, method: 'unknown/method', params: {} },
    })
    expect(res.statusCode).toBe(501)
    expect(res.json().error).toBe('UNSUPPORTED_OPERATION')
  })
})
