import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../../src/gateway/server.js'
import { healthRoutes } from '../../src/gateway/routes/health.js'
import { oauthMetadataRoutes } from '../../src/gateway/routes/oauth-metadata.js'
import { mcpRoutes } from '../../src/gateway/routes/mcp.js'
import { MemorySessionStore } from '../../src/session/store.js'
import { DownstreamRegistry } from '../../src/registry/registry.js'
import { SelectorEngine } from '../../src/selector/engine.js'
import { TriggerEngine } from '../../src/trigger/index.js'
import { initConfig, setConfig } from '../../src/config/index.js'
import {
  defaultDebug,
  defaultResilience,
  defaultSelector,
  defaultSession,
  defaultTriggers,
} from '../fixtures/bootstrap-json.js'
import type { FastifyInstance } from 'fastify'
import { resetInboundIssuerMetadataCache } from '../../src/auth/oauth-issuer-metadata.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, '__tmp_oauth_integration__')

const basePolicies = {
  namespaces: {
    gmail: {
      allowedRoles: ['user', 'admin'],
      bootstrapWindowSize: 4,
      candidatePoolSize: 16,
      allowedModes: ['read', 'write'],
    },
  },
  roles: {
    user: { allowNamespaces: ['gmail'], denyModes: ['admin' as const] },
    admin: { allowNamespaces: ['gmail'] },
  },
  selector: defaultSelector,
  session: defaultSession,
  triggers: defaultTriggers,
  resilience: defaultResilience,
  debug: defaultDebug,
  starterPacks: {},
}

let app: FastifyInstance
let disposeSessionBackend: () => void
let registry: DownstreamRegistry
let oauthConfigSnapshot: ReturnType<typeof initConfig>

afterEach(() => {
  resetInboundIssuerMetadataCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(
    join(TMP, 'bootstrap.json'),
    JSON.stringify(
        {
          servers: [],
          auth: {
            mode: 'oauth',
            oauth: {
              publicBaseUrl: 'https://gw.oauth.test',
              authorizationServers: [{ issuer: 'https://issuer.oauth.test', rolesClaim: 'roles' }],
              allowedBrowserOrigins: ['https://chatgpt.com/', 'https://allowed.example'],
            },
          },
          ...basePolicies,
        },
      null,
      2,
    ),
  )
  oauthConfigSnapshot = initConfig(TMP)

  const store = new MemorySessionStore()
  store.start(defaultSession.ttlSeconds, defaultSession.cleanupIntervalSeconds)
  disposeSessionBackend = () => {
    store.stop()
  }
  registry = new DownstreamRegistry()
  const selector = new SelectorEngine()
  const triggerEngine = new TriggerEngine(store, registry, selector)
  app = buildServer({ logLevel: 'silent' })
  await app.register(healthRoutes)
  await app.register(oauthMetadataRoutes)
  await app.register(mcpRoutes, { store, registry, triggerEngine })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  registry?.stop()
  disposeSessionBackend?.()
  rmSync(TMP, { recursive: true, force: true })
})

describe('RFC 9728 metadata (oauth mode)', () => {
  it('exposes authorization-server and openid metadata aliases used by remote MCP clients', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const value = String(url)
        if (value === 'https://issuer.oauth.test/.well-known/oauth-authorization-server') {
          return new Response(
            JSON.stringify({
              issuer: 'https://issuer.oauth.test',
              authorization_endpoint: 'https://issuer.oauth.test/oauth2/authorize',
              token_endpoint: 'https://issuer.oauth.test/oauth2/token',
              jwks_uri: 'https://issuer.oauth.test/oauth2/jwks',
              response_types_supported: ['code'],
            }),
            { status: 200 },
          )
        }
        if (value === 'https://issuer.oauth.test/.well-known/openid-configuration') {
          return new Response(
            JSON.stringify({
              issuer: 'https://issuer.oauth.test',
              authorization_endpoint: 'https://issuer.oauth.test/oauth2/authorize',
              token_endpoint: 'https://issuer.oauth.test/oauth2/token',
              jwks_uri: 'https://issuer.oauth.test/oauth2/jwks',
              response_types_supported: ['code'],
            }),
            { status: 200 },
          )
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const authServerRes = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server/mcp/gmail',
    })
    expect(authServerRes.statusCode).toBe(200)
    expect(authServerRes.json()).toMatchObject({
      issuer: 'https://issuer.oauth.test',
      authorization_endpoint: 'https://issuer.oauth.test/oauth2/authorize',
      token_endpoint: 'https://issuer.oauth.test/oauth2/token',
      resource: 'https://gw.oauth.test/mcp/gmail',
      scopes_supported: ['openid'],
    })

    const authServerAltRes = await app.inject({
      method: 'GET',
      url: '/mcp/gmail/.well-known/oauth-authorization-server',
    })
    expect(authServerAltRes.statusCode).toBe(200)

    const openIdNsRes = await app.inject({
      method: 'GET',
      url: '/.well-known/openid-configuration/mcp/gmail',
    })
    expect(openIdNsRes.statusCode).toBe(200)
    expect(openIdNsRes.json()).toMatchObject({
      issuer: 'https://issuer.oauth.test',
      resource: 'https://gw.oauth.test/mcp/gmail',
    })

    const openIdAltRes = await app.inject({
      method: 'GET',
      url: '/mcp/gmail/.well-known/openid-configuration',
    })
    expect(openIdAltRes.statusCode).toBe(200)

    const openIdGlobalRes = await app.inject({
      method: 'GET',
      url: '/.well-known/openid-configuration',
    })
    expect(openIdGlobalRes.statusCode).toBe(200)
    expect(openIdGlobalRes.json().resource).toBeUndefined()
  })

  it('returns protected resource JSON for a valid namespace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/mcp/gmail',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.resource).toBe('https://gw.oauth.test/mcp/gmail')
    expect(body.authorization_servers).toEqual(['https://issuer.oauth.test'])
    expect(body.bearer_methods_supported).toEqual(['header'])
    expect(Array.isArray(body.scopes_supported)).toBe(true)
  })

  it('exposes the same document under /mcp/:ns/.well-known/oauth-protected-resource', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/mcp/gmail/.well-known/oauth-protected-resource',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().resource).toBe('https://gw.oauth.test/mcp/gmail')
  })

  it('returns CORS headers for allowed browser origins on metadata routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/mcp/gmail',
      headers: { origin: 'https://chatgpt.com' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('https://chatgpt.com')
    expect(res.headers['vary']).toBe('Origin')
  })

  it('returns CORS headers for loopback browser origins on metadata routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/mcp/gmail/.well-known/oauth-protected-resource',
      headers: { origin: 'http://localhost:6274' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:6274')
  })

  it('does not return CORS headers for origins outside the allowlist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/mcp/gmail',
      headers: { origin: 'https://denied.example' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('rejects hostile prefix-match origins for MCP requests', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/mcp/gmail',
      headers: { origin: 'https://chatgpt.com.attacker.tld' },
    })

    expect(res.statusCode).toBe(403)
  })
})

describe('OAuth initialize challenge', () => {
  it('returns 401 with WWW-Authenticate when no Bearer token is sent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    expect(res.statusCode).toBe(401)
    const www = res.headers['www-authenticate']
    expect(www).toBeDefined()
    expect(String(www)).toContain('resource_metadata=')
    expect(String(www)).toContain('scope=')
  })
})

describe('metadata disabled for static_key', () => {
  let staticApp: FastifyInstance
  let disposeStaticBackend: () => void
  let reg2: DownstreamRegistry

  beforeAll(async () => {
    mkdirSync(TMP + '_static', { recursive: true })
    writeFileSync(
      join(TMP + '_static', 'bootstrap.json'),
      JSON.stringify(
        {
          servers: [],
          auth: { mode: 'static_key' },
          ...basePolicies,
        },
        null,
        2,
      ),
    )
    initConfig(TMP + '_static')
    const store2 = new MemorySessionStore()
    store2.start(defaultSession.ttlSeconds, defaultSession.cleanupIntervalSeconds)
    disposeStaticBackend = () => {
      store2.stop()
    }
    reg2 = new DownstreamRegistry()
    const selector = new SelectorEngine()
    const triggerEngine = new TriggerEngine(store2, reg2, selector)
    staticApp = buildServer({ logLevel: 'silent' })
    await staticApp.register(healthRoutes)
    await staticApp.register(oauthMetadataRoutes)
    await staticApp.register(mcpRoutes, { store: store2, registry: reg2, triggerEngine })
    await staticApp.ready()
  })

  afterAll(async () => {
    await staticApp?.close()
    reg2?.stop()
    disposeStaticBackend?.()
    rmSync(TMP + '_static', { recursive: true, force: true })
    setConfig(oauthConfigSnapshot)
  })

  it('returns 404 for protected-resource URL when inbound OAuth is off', async () => {
    const res = await staticApp.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/mcp/gmail',
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for authorization-server and openid metadata aliases when inbound OAuth is off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unexpected', { status: 200 })),
    )

    const authServerRes = await staticApp.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server/mcp/gmail',
    })
    expect(authServerRes.statusCode).toBe(404)

    const openIdRes = await staticApp.inject({
      method: 'GET',
      url: '/mcp/gmail/.well-known/openid-configuration',
    })
    expect(openIdRes.statusCode).toBe(404)
  })
})
