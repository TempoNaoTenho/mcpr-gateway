/**
 * Restart behavior integration tests
 *
 * Covers:
 *   1. SESSION_NOT_FOUND when session store is replaced (simulates restart)
 *   2. SESSION_NOT_FOUND response format is correct
 *   3. Client can re-initialize after SESSION_NOT_FOUND and get a working new session
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../../src/gateway/server.js'
import { healthRoutes } from '../../src/gateway/routes/health.js'
import { mcpRoutes } from '../../src/gateway/routes/mcp.js'
import { openStandaloneSqlite } from '../../src/db/adapters/sqlite/index.js'
import { SqliteSessionRepository } from '../../src/repositories/sessions/sqlite.js'
import type { ISessionStore } from '../../src/types/interfaces.js'
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
const TMP = join(__dirname, '__tmp_restart__')

const AUTH_ALICE = { Authorization: 'Bearer alice:user' }

function openSessionStore(dbPath: string): { store: SqliteSessionRepository; close: () => void } {
  const { db, close } = openStandaloneSqlite(dbPath)
  return { store: new SqliteSessionRepository(db), close }
}

/**
 * Builds a fresh gateway app with the provided session store.
 * Used to simulate a "restart" by switching to a new store.
 */
async function buildApp(storeInstance: ISessionStore): Promise<FastifyInstance> {
  const registry = trackRegistry(new DownstreamRegistry())
  const selector = new SelectorEngine()
  const triggerEngine = new TriggerEngine(storeInstance, registry, selector)

  const instance = buildServer({ logLevel: 'silent' })
  instance.register(healthRoutes)
  instance.register(mcpRoutes, { store: storeInstance, registry, triggerEngine })
  await instance.ready()

  return instance
}

const createdRegistries: DownstreamRegistry[] = []

function trackRegistry(registry: DownstreamRegistry): DownstreamRegistry {
  createdRegistries.push(registry)
  return registry
}

let originalApp: FastifyInstance | undefined

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(
    join(TMP, 'bootstrap.json'),
    JSON.stringify(
      {
        servers: [],
        auth: { mode: 'static_key' },
        namespaces: {
          gmail: {
            allowedRoles: ['user', 'admin'],
            bootstrapWindowSize: 4,
            candidatePoolSize: 16,
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
})

afterAll(async () => {
  await originalApp?.close()
  for (const registry of createdRegistries) {
    registry.stop()
  }
  rmSync(TMP, { recursive: true, force: true })
})

describe('Restart — SESSION_NOT_FOUND após reinicialização do store', () => {
  it('returns 404 SESSION_NOT_FOUND when session store is replaced after session creation', async () => {
    // --- Original "instance" before restart ---
    const { store: originalStore, close: closeOriginal } = openSessionStore(
      join(TMP, 'restart-original.db')
    )
    const app = await buildApp(originalStore)
    originalApp = app

    // Create a session in the original store
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    })
    const oldSessionId = initRes.headers['mcp-session-id'] as string
    expect(oldSessionId).toBeDefined()

    // Confirm the session works before "restart"
    const listBefore = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: {
        'Content-Type': 'application/json',
        ...AUTH_ALICE,
        'mcp-session-id': oldSessionId,
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    })
    expect(listBefore.statusCode).toBe(200)

    // --- Simulate restart: create a brand-new app with a fresh store ---
    const { store: newStore, close: closeNew } = openSessionStore(join(TMP, 'restart-new.db'))
    const newApp = await buildApp(newStore)

    // The old session ID is not known to the new store
    const listAfterRestart = await newApp.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: {
        'Content-Type': 'application/json',
        ...AUTH_ALICE,
        'mcp-session-id': oldSessionId,
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    })

    expect(listAfterRestart.statusCode).toBe(404)
    expect(listAfterRestart.json().error).toBe('SESSION_NOT_FOUND')

    await newApp.close()
    closeNew()
    originalStore.stop()
    await app.close()
    closeOriginal()
    originalApp = undefined
  })
})

describe('Restart — SESSION_NOT_FOUND formato de resposta', () => {
  it('SESSION_NOT_FOUND response has correct error field', async () => {
    const { store, close } = openSessionStore(join(TMP, 'restart-fmt.db'))
    const app = await buildApp(store)

    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.error).toBe('SESSION_NOT_FOUND')
    expect(typeof body.message).toBe('string')

    store.stop()
    await app.close()
    close()
  })

  it('SESSION_NOT_FOUND returned for tools/call without session', async () => {
    const { store, close } = openSessionStore(join(TMP, 'restart-call.db'))
    const app = await buildApp(store)

    const res = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_email' } },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('SESSION_NOT_FOUND')

    store.stop()
    await app.close()
    close()
  })
})

describe('Restart — reinicialização limpa', () => {
  it('after SESSION_NOT_FOUND, client can initialize and get a working new session', async () => {
    const { store, close } = openSessionStore(join(TMP, 'restart-reinit.db'))
    const app = await buildApp(store)

    // Step 1: Try with an invalid/unknown session ID → SESSION_NOT_FOUND
    const invalidSessionId = 'invalid-session-id-xyz-123'
    const firstAttempt = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: {
        'Content-Type': 'application/json',
        ...AUTH_ALICE,
        'mcp-session-id': invalidSessionId,
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })
    expect(firstAttempt.statusCode).toBe(404)
    expect(firstAttempt.json().error).toBe('SESSION_NOT_FOUND')

    // Step 2: Re-initialize → new session created
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
      payload: { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} },
    })
    expect(initRes.statusCode).toBe(200)
    const newSessionId = initRes.headers['mcp-session-id'] as string
    expect(newSessionId).toBeDefined()
    expect(newSessionId).not.toBe(invalidSessionId)

    // Step 3: New session ID works for tools/list
    const listRes = await app.inject({
      method: 'POST',
      url: '/mcp/gmail',
      headers: {
        'Content-Type': 'application/json',
        ...AUTH_ALICE,
        'mcp-session-id': newSessionId,
      },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    })
    expect(listRes.statusCode).toBe(200)
    expect(Array.isArray(listRes.json().result.tools)).toBe(true)

    store.stop()
    await app.close()
    close()
  })

  it('each new initialize produces a unique session ID', async () => {
    const { store, close } = openSessionStore(join(TMP, 'restart-ids.db'))
    const app = await buildApp(store)

    const ids = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp/gmail',
        headers: { 'Content-Type': 'application/json', ...AUTH_ALICE },
        payload: { jsonrpc: '2.0', id: i + 1, method: 'initialize', params: {} },
      })
      expect(res.statusCode).toBe(200)
      ids.add(res.headers['mcp-session-id'] as string)
    }

    // All 3 session IDs must be distinct
    expect(ids.size).toBe(3)

    store.stop()
    await app.close()
    close()
  })
})
