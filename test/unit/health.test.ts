import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/index.js'
import { buildServer } from '../../src/gateway/server.js'
import { healthRoutes } from '../../src/gateway/routes/health.js'

beforeAll(async () => {
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('GET /health', () => {
  it('responds with 200 and status ok', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })
})

describe('GET /healthz', () => {
  it('responds with 200 and status ok', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })
})

describe('POST /registry/refresh', () => {
  it('allows loopback callers to refresh the registry', async () => {
    const refreshAll = async () => undefined
    const listServers = async () => [{ id: 'gmail', enabled: true }]
    const getTools = async () => [{ name: 'list_messages' }]

    const localApp = buildServer({ logLevel: 'silent' })
    localApp.register(healthRoutes, {
      registry: { refreshAll, listServers, getTools } as any,
    })
    await localApp.ready()

    const response = await localApp.inject({
      method: 'POST',
      url: '/registry/refresh',
      remoteAddress: '127.0.0.1',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ refreshed: true, serverCount: 1, toolCount: 1 })

    await localApp.close()
  })

  it('rejects non-loopback callers', async () => {
    const refreshAll = async () => undefined
    const listServers = async () => []
    const getTools = async () => []

    const localApp = buildServer({ logLevel: 'silent' })
    localApp.register(healthRoutes, {
      registry: { refreshAll, listServers, getTools } as any,
    })
    await localApp.ready()

    const response = await localApp.inject({
      method: 'POST',
      url: '/registry/refresh',
      remoteAddress: '203.0.113.7',
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      refreshed: false,
      error: 'registry refresh is only available from loopback addresses',
    })

    await localApp.close()
  })
})
