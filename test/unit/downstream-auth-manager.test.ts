import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../../src/config/index.js'
import { DownstreamAuthManager } from '../../src/registry/auth/manager.js'

const baseConfig = {
  servers: [],
  auth: { mode: 'static_key' as const },
  namespaces: {},
  roles: {},
  selector: {},
  session: {},
  triggers: {},
  resilience: {},
  debug: {},
  codeMode: {},
  starterPacks: {},
  allowedOAuthProviders: ['https://issuer.example.com'],
}

function makeRepo() {
  const entries = new Map<string, unknown>()

  return {
    async get(serverId: string, kind: string) {
      return entries.get(`${serverId}:${kind}`)
    },
    async save(input: { serverId: string; kind: string; [key: string]: unknown }) {
      entries.set(`${input.serverId}:${input.kind}`, input)
    },
    async delete(serverId: string, kind?: string) {
      if (kind) {
        entries.delete(`${serverId}:${kind}`)
        return
      }
      for (const key of [...entries.keys()]) {
        if (key.startsWith(`${serverId}:`)) {
          entries.delete(key)
        }
      }
    },
    async listByServer(serverId: string) {
      return [...entries.values()].filter((entry) => {
        return typeof entry === 'object' && entry !== null && 'serverId' in entry && (entry as { serverId: string }).serverId === serverId
      })
    },
  }
}

describe('DownstreamAuthManager OAuth runtime detection', () => {
  beforeEach(() => {
    setConfig(baseConfig as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['DOWNSTREAM_AUTH_ENCRYPTION_KEY']
    setConfig(baseConfig as never)
  })

  it('falls back from oauth-authorization-server to openid-configuration and keeps OAuth usable', async () => {
    process.env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'] = Buffer.alloc(32, 11).toString('base64')

    const manager = new DownstreamAuthManager(makeRepo() as never)
    const server = {
      id: 'supabase-iapechincheira',
      namespaces: ['default'],
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      auth: {
        mode: 'none',
      },
      enabled: true,
      trustLevel: 'verified',
    } as const

    manager.syncServers([server as never])

    await expect(
      manager.handleUnauthorized(
        server.id,
        'Bearer realm="mcp", authorization_uri="https://issuer.example.com"'
      )
    ).rejects.toMatchObject({
      details: {
        serverId: server.id,
        authorizationServer: 'https://issuer.example.com',
      },
    })

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method?.toUpperCase() ?? 'GET'

      if (method === 'GET' && url === 'https://issuer.example.com/.well-known/oauth-authorization-server') {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        }
      }

      if (method === 'GET' && url === 'https://issuer.example.com/.well-known/openid-configuration') {
        return {
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://issuer.example.com/authorize',
            token_endpoint: 'https://issuer.example.com/token',
            registration_endpoint: 'https://issuer.example.com/register',
          }),
        }
      }

      if (method === 'POST' && url === 'https://issuer.example.com/register') {
        return {
          ok: true,
          json: async () => ({
            client_id: 'client-123',
          }),
        }
      }

      if (method === 'POST' && url === 'https://issuer.example.com/token') {
        return {
          ok: true,
          json: async () => ({
            access_token: 'access-123',
            refresh_token: 'refresh-456',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        }
      }

      throw new Error(`Unexpected fetch call: ${method} ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock as never)

    const { authorizeUrl } = await manager.beginOAuth(server.id, 'http://localhost:3000')
    const oauthState = new URL(authorizeUrl).searchParams.get('state')
    expect(oauthState).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://issuer.example.com/.well-known/oauth-authorization-server',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' }),
      })
    )

    await expect(manager.completeOAuth(oauthState!, 'auth-code-123')).resolves.toEqual({
      serverId: server.id,
      authorizationServer: 'https://issuer.example.com',
    })

    expect(await manager.resolveAuthHeaders(server as never)).toEqual({
      Authorization: 'Bearer access-123',
    })
  })

  it('uses the token endpoint auth method returned by dynamic client registration', async () => {
    process.env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'] = Buffer.alloc(32, 66).toString('base64')

    const manager = new DownstreamAuthManager(makeRepo() as never)
    const server = {
      id: 'supabase-iapechincheira',
      namespaces: ['default'],
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      auth: {
        mode: 'none',
      },
      enabled: true,
      trustLevel: 'verified',
    } as const

    manager.syncServers([server as never])

    await expect(
      manager.handleUnauthorized(
        server.id,
        'Bearer realm="mcp", authorization_uri="https://issuer.example.com"'
      )
    ).rejects.toMatchObject({
      details: {
        serverId: server.id,
        authorizationServer: 'https://issuer.example.com',
      },
    })

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method?.toUpperCase() ?? 'GET'

      if (method === 'GET' && url === 'https://issuer.example.com/.well-known/oauth-authorization-server') {
        return {
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://issuer.example.com/authorize',
            token_endpoint: 'https://issuer.example.com/token',
            registration_endpoint: 'https://issuer.example.com/register',
          }),
        }
      }

      if (method === 'POST' && url === 'https://issuer.example.com/register') {
        return {
          ok: true,
          json: async () => ({
            client_id: 'client-123',
            client_secret: 'secret-abc',
            token_endpoint_auth_method: 'client_secret_basic',
          }),
        }
      }

      if (method === 'POST' && url === 'https://issuer.example.com/token') {
        expect(init?.headers).toMatchObject({
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from('client-123:secret-abc', 'utf8').toString('base64')}`,
        })
        const body = init?.body
        expect(body).toBeInstanceOf(URLSearchParams)
        expect((body as URLSearchParams).get('client_id')).toBeNull()
        return {
          ok: true,
          json: async () => ({
            access_token: 'access-789',
            refresh_token: 'refresh-789',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        }
      }

      throw new Error(`Unexpected fetch call: ${method} ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock as never)

    const { authorizeUrl } = await manager.beginOAuth(server.id, 'http://127.0.0.1:3001')
    const oauthState = new URL(authorizeUrl).searchParams.get('state')
    expect(oauthState).toBeTruthy()

    await expect(manager.completeOAuth(oauthState!, 'auth-code-789')).resolves.toEqual({
      serverId: server.id,
      authorizationServer: 'https://issuer.example.com',
    })
  })

  it('resolves resource_metadata challenges to the actual OAuth issuer before starting OAuth', async () => {
    process.env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'] = Buffer.alloc(32, 22).toString('base64')

    const manager = new DownstreamAuthManager(makeRepo() as never)
    const server = {
      id: 'supabase-iapechincheira',
      namespaces: ['default'],
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      auth: {
        mode: 'none',
      },
      enabled: true,
      trustLevel: 'verified',
    } as const

    manager.syncServers([server as never])

    await expect(
      manager.handleUnauthorized(
        server.id,
        'Bearer realm="mcp", resource_metadata="https://resource.example.com/.well-known/oauth-protected-resource"'
      )
    ).rejects.toMatchObject({
      details: {
        serverId: server.id,
        authorizationServer: 'https://resource.example.com/.well-known/oauth-protected-resource',
      },
    })

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_servers: ['https://issuer.example.com'],
          resource: 'https://example.com/mcp',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://issuer.example.com/authorize',
          token_endpoint: 'https://issuer.example.com/token',
          registration_endpoint: 'https://issuer.example.com/register',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          client_id: 'client-456',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://issuer.example.com/authorize',
          token_endpoint: 'https://issuer.example.com/token',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access-456',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      })

    vi.stubGlobal('fetch', fetchMock as never)

    const { authorizeUrl } = await manager.beginOAuth(server.id, 'http://localhost:3000')
    const url = new URL(authorizeUrl)
    expect(url.searchParams.get('resource')).toBe('https://example.com/mcp')

    const oauthState = url.searchParams.get('state')
    expect(oauthState).toBeTruthy()

    await expect(manager.completeOAuth(oauthState!, 'auth-code-456')).resolves.toEqual({
      serverId: server.id,
      authorizationServer: 'https://issuer.example.com',
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'https://issuer.example.com/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(URLSearchParams),
      })
    )
    const tokenBody = fetchMock.mock.calls[4]?.[1]?.body
    expect(tokenBody).toBeInstanceOf(URLSearchParams)
    expect((tokenBody as URLSearchParams).get('resource')).toBe('https://example.com/mcp')

    expect(await manager.resolveAuthHeaders(server as never)).toEqual({
      Authorization: 'Bearer access-456',
    })
  })

  it('rejects expired OAuth state values before token exchange', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-03-25T16:00:00.000Z'))
      process.env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'] = Buffer.alloc(32, 55).toString('base64')

      const manager = new DownstreamAuthManager(makeRepo() as never)
      const server = {
        id: 'supabase-iapechincheira',
        namespaces: ['default'],
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        auth: {
          mode: 'none',
        },
        enabled: true,
        trustLevel: 'verified',
      } as const

      manager.syncServers([server as never])

      await expect(
        manager.handleUnauthorized(
          server.id,
          'Bearer realm="mcp", authorization_uri="https://issuer.example.com"'
        )
      ).rejects.toMatchObject({
        details: {
          serverId: server.id,
          authorizationServer: 'https://issuer.example.com',
        },
      })

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://issuer.example.com/authorize',
            token_endpoint: 'https://issuer.example.com/token',
            registration_endpoint: 'https://issuer.example.com/register',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            client_id: 'client-789',
          }),
        })

      vi.stubGlobal('fetch', fetchMock as never)

      const { authorizeUrl } = await manager.beginOAuth(server.id, 'http://127.0.0.1:3001')
      const oauthState = new URL(authorizeUrl).searchParams.get('state')
      expect(oauthState).toBeTruthy()

      vi.advanceTimersByTime(10 * 60 * 1000 + 1)

      await expect(manager.completeOAuth(oauthState!, 'auth-code-expired')).rejects.toThrow(
        'OAuth state is invalid or expired'
      )

      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses confidential client credentials during token refresh', async () => {
    process.env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'] = Buffer.alloc(32, 77).toString('base64')

    const manager = new DownstreamAuthManager(makeRepo() as never)
    const server = {
      id: 'supabase-iapechincheira',
      namespaces: ['default'],
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      auth: {
        mode: 'none',
      },
      enabled: true,
      trustLevel: 'verified',
    } as const

    manager.syncServers([server as never])

    await expect(
      manager.handleUnauthorized(
        server.id,
        'Bearer realm="mcp", authorization_uri="https://issuer.example.com"'
      )
    ).rejects.toMatchObject({
      details: {
        serverId: server.id,
        authorizationServer: 'https://issuer.example.com',
      },
    })

    let tokenCallCount = 0
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method?.toUpperCase() ?? 'GET'

      if (method === 'GET' && url === 'https://issuer.example.com/.well-known/oauth-authorization-server') {
        return {
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://issuer.example.com/authorize',
            token_endpoint: 'https://issuer.example.com/token',
            registration_endpoint: 'https://issuer.example.com/register',
          }),
        }
      }

      if (method === 'POST' && url === 'https://issuer.example.com/register') {
        return {
          ok: true,
          json: async () => ({
            client_id: 'client-555',
            client_secret: 'secret-555',
            token_endpoint_auth_method: 'client_secret_basic',
          }),
        }
      }

      if (method === 'POST' && url === 'https://issuer.example.com/token') {
        tokenCallCount += 1
        expect(init?.headers).toMatchObject({
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from('client-555:secret-555', 'utf8').toString('base64')}`,
        })
        const body = init?.body
        expect(body).toBeInstanceOf(URLSearchParams)
        if (tokenCallCount === 1) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'access-initial',
              refresh_token: 'refresh-initial',
              expires_in: 1,
              token_type: 'Bearer',
            }),
          }
        }
        expect((body as URLSearchParams).get('grant_type')).toBe('refresh_token')
        expect((body as URLSearchParams).get('refresh_token')).toBe('refresh-initial')
        return {
          ok: true,
          json: async () => ({
            access_token: 'access-refreshed',
            refresh_token: 'refresh-refreshed',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        }
      }

      throw new Error(`Unexpected fetch call: ${method} ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock as never)

    const { authorizeUrl } = await manager.beginOAuth(server.id, 'http://127.0.0.1:3001')
    const oauthState = new URL(authorizeUrl).searchParams.get('state')
    expect(oauthState).toBeTruthy()

    await manager.completeOAuth(oauthState!, 'auth-code-555')

    await new Promise((resolve) => setTimeout(resolve, 1100))

    await expect(manager.resolveAuthHeaders(server as never)).resolves.toEqual({
      Authorization: 'Bearer access-refreshed',
    })
  })

  it('surfaces the exact discovery error when protected resource metadata omits authorization_servers', async () => {
    process.env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'] = Buffer.alloc(32, 33).toString('base64')

    const manager = new DownstreamAuthManager(makeRepo() as never)
    const server = {
      id: 'supabase-iapechincheira',
      namespaces: ['default'],
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      auth: {
        mode: 'none',
      },
      enabled: true,
      trustLevel: 'verified',
    } as const

    manager.syncServers([server as never])

    await expect(
      manager.handleUnauthorized(
        server.id,
        'Bearer realm="mcp", resource_metadata="https://resource.example.com/.well-known/oauth-protected-resource"'
      )
    ).rejects.toMatchObject({
      details: {
        serverId: server.id,
        authorizationServer: 'https://resource.example.com/.well-known/oauth-protected-resource',
      },
    })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          resource: 'https://example.com/mcp',
        }),
      }) as never
    )

    await expect(manager.beginOAuth(server.id, 'http://localhost:3000')).rejects.toThrow(
      'OAuth discovery response from https://resource.example.com/.well-known/oauth-protected-resource is missing authorization_endpoint/token_endpoint or authorization_servers'
    )
  })

  it('surfaces allowlist failures instead of masking them as discovery format errors', async () => {
    process.env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'] = Buffer.alloc(32, 44).toString('base64')
    setConfig({
      ...baseConfig,
      allowedOAuthProviders: ['https://issuer.example.com'],
    } as never)

    const manager = new DownstreamAuthManager(makeRepo() as never)
    const server = {
      id: 'supabase-iapechincheira',
      namespaces: ['default'],
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      auth: {
        mode: 'none',
      },
      enabled: true,
      trustLevel: 'verified',
    } as const

    manager.syncServers([server as never])

    await expect(
      manager.handleUnauthorized(
        server.id,
        'Bearer realm="mcp", resource_metadata="https://resource.example.com/.well-known/oauth-protected-resource"'
      )
    ).rejects.toMatchObject({
      details: {
        serverId: server.id,
        authorizationServer: 'https://resource.example.com/.well-known/oauth-protected-resource',
      },
    })

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_servers: ['https://blocked.example.com'],
        }),
      })

    vi.stubGlobal('fetch', fetchMock as never)

    await expect(manager.beginOAuth(server.id, 'http://localhost:3000')).rejects.toThrow(
      'OAuth provider URL is not allowed: https://blocked.example.com'
    )
  })
})
