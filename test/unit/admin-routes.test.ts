import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from '../../src/gateway/server.js'
import { adminRoutes } from '../../src/gateway/routes/admin.js'
import { createDefaultAdminConfig, type AdminConfig } from '../../src/config/loader.js'
import { GatewayMode, SourceTrustLevel } from '../../src/types/enums.js'
import { RuntimeConfigManager } from '../../src/config/runtime.js'
import { DownstreamRegistry } from '../../src/registry/registry.js'
import { downstreamAuthManager } from '../../src/registry/auth/index.js'
import { loadConfig } from '../../src/config/loader.js'
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, '__tmp_admin_file_mode__')

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['ADMIN_TOKEN']
  delete process.env['GATEWAY_ADMIN_USER']
  delete process.env['GATEWAY_ADMIN_PASSWORD']
  delete process.env['NODE_ENV']
  delete process.env['DOWNSTREAM_AUTH_ENCRYPTION_KEY']
  downstreamAuthManager.setRepository(undefined)
  rmSync(TMP, { recursive: true, force: true })
})

function mergeHarnessAuth(
  base: AdminConfig['auth'],
  override: AdminConfig['auth'] | undefined,
): AdminConfig['auth'] {
  if (override === undefined) return base
  if ('mode' in override && override.mode !== undefined) {
    return override
  }
  return { ...base, ...override } as AdminConfig['auth']
}

function createAdminHarness(initial?: Partial<AdminConfig>) {
  const defaults = createDefaultAdminConfig(['gmail'])
  const { auth: initialAuth, ...restInitial } = initial ?? {}
  let current: AdminConfig = {
    ...defaults,
    ...restInitial,
    auth: mergeHarnessAuth(defaults.auth, initialAuth as AdminConfig['auth'] | undefined),
  }

  const configRepo = {
    async getActive() {
      return current
    },
    async save(config: AdminConfig) {
      current = config
      return 1
    },
    async listVersions() {
      return []
    },
    async rollback() {},
  }

  const configManager = {
    getBootstrap() {
      const a = current.auth
      if (a.mode === 'static_key') return { mode: 'static_key' as const }
      if (a.mode === 'oauth') return { mode: 'oauth' as const, oauth: a.oauth }
      return { mode: 'hybrid' as const, oauth: a.oauth }
    },
    getEffective() {
      return { ...current }
    },
    getAdminConfig() {
      return current
    },
    async saveAdminConfig(config: AdminConfig) {
      current = config
      return 1
    },
    async rollback() {},
  }

  return {
    configRepo,
    configManager,
    getCurrent: () => current,
  }
}

function createFileModeManager() {
  mkdirSync(TMP, { recursive: true })
  const defaults = createDefaultAdminConfig(['default'])
  writeFileSync(
    join(TMP, 'bootstrap.json'),
    JSON.stringify(
      {
        ...defaults,
        auth: { mode: 'static_key' },
      },
      null,
      2
    )
  )

  const initial = loadConfig(TMP)
  return new RuntimeConfigManager({
    bootstrap: { auth: initial.auth },
    initial,
    registry: new DownstreamRegistry(),
    configPath: TMP,
  })
}

function makeToolRecord(
  overrides?: Partial<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
    serverId: string
    namespace: string
  }>
) {
  return {
    name: overrides?.name ?? 'docs_search',
    description: overrides?.description ?? 'Search the docs',
    inputSchema: overrides?.inputSchema ?? {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
    serverId: overrides?.serverId ?? 'docs',
    namespace: overrides?.namespace ?? 'default',
    retrievedAt: '2026-03-22T12:00:00.000Z',
    sanitized: false,
  }
}

describe('adminRoutes', () => {
  it('GET /admin/auth/config returns username and passwordRequired', async () => {
    process.env['ADMIN_TOKEN'] = 'secret-token'
    process.env['GATEWAY_ADMIN_USER'] = 'custom-admin'
    process.env['GATEWAY_ADMIN_PASSWORD'] = 'secret'

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {})
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/admin/auth/config' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({
      username: 'custom-admin',
      passwordRequired: true,
    })

    delete process.env['GATEWAY_ADMIN_PASSWORD']
    const resNoPw = await app.inject({ method: 'GET', url: '/admin/auth/config' })
    expect(resNoPw.statusCode).toBe(200)
    expect(JSON.parse(resNoPw.payload)).toEqual({
      username: 'custom-admin',
      passwordRequired: true,
    })

    await app.close()
  })

  it('matches GATEWAY_ADMIN_PASSWORD after trimming env and login body (UI sends trimmed password)', async () => {
    process.env['ADMIN_TOKEN'] = 'secret-token'
    process.env['GATEWAY_ADMIN_PASSWORD'] = '  secret  '

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {})
    await app.ready()

    const cfgRes = await app.inject({ method: 'GET', url: '/admin/auth/config' })
    expect(cfgRes.statusCode).toBe(200)
    expect(JSON.parse(cfgRes.payload)).toMatchObject({ passwordRequired: true })

    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'mcpgateway', password: 'secret' },
    })
    expect(loginRes.statusCode).toBe(200)

    await app.close()
  })

  it('treats whitespace-only GATEWAY_ADMIN_PASSWORD as misconfigured when admin auth is enabled', async () => {
    process.env['ADMIN_TOKEN'] = 'secret-token'
    process.env['GATEWAY_ADMIN_PASSWORD'] = '  \t  '

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {})
    await app.ready()

    const cfgRes = await app.inject({ method: 'GET', url: '/admin/auth/config' })
    expect(cfgRes.statusCode).toBe(200)
    expect(JSON.parse(cfgRes.payload)).toMatchObject({ passwordRequired: true })

    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'mcpgateway', password: '' },
    })
    expect(loginRes.statusCode).toBe(503)

    await app.close()
  })

  it('rejects login when GATEWAY_ADMIN_PASSWORD is unset and admin auth is enabled', async () => {
    process.env['ADMIN_TOKEN'] = 'secret-token'
    delete process.env['GATEWAY_ADMIN_PASSWORD']

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {})
    await app.ready()

    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'mcpgateway', password: '' },
    })

    expect(loginRes.statusCode).toBe(503)

    await app.close()
  })

  it('revokes the server-side admin session on logout', async () => {
    process.env['ADMIN_TOKEN'] = 'secret-token'
    process.env['GATEWAY_ADMIN_PASSWORD'] = 'admin-password'

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {})
    await app.ready()

    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'mcpgateway', password: 'admin-password' },
    })

    expect(loginRes.statusCode).toBe(200)
    const sessionCookie = loginRes.cookies.find((cookie) => cookie.name === 'admin_session')
    expect(sessionCookie?.value).toBeTruthy()

    const dashboardBeforeLogout = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      cookies: { admin_session: sessionCookie!.value },
    })

    expect(dashboardBeforeLogout.statusCode).toBe(200)

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/logout',
      cookies: { admin_session: sessionCookie!.value },
    })

    expect(logoutRes.statusCode).toBe(200)

    const dashboardAfterLogout = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      cookies: { admin_session: sessionCookie!.value },
    })

    expect(dashboardAfterLogout.statusCode).toBe(401)

    await app.close()
  })

  it('allows the downstream OAuth callback without an admin session while keeping other admin routes protected', async () => {
    process.env['ADMIN_TOKEN'] = 'secret-token'

    const app = buildServer({ logLevel: 'silent' })
    const completeSpy = vi.spyOn(downstreamAuthManager, 'completeOAuth').mockResolvedValue({
      serverId: 'fast-mcp-docs',
      authorizationServer: 'https://issuer.example.com',
    })

    await app.register(adminRoutes, {
      registry: {
        async refreshTools() {
          return [{ name: 'docs_search' }]
        },
      } as any,
    })
    await app.ready()

    const dashboardRes = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
    })
    expect(dashboardRes.statusCode).toBe(401)

    const callbackRes = await app.inject({
      method: 'GET',
      url: '/admin/downstream-auth/callback?state=abc&code=xyz',
    })
    expect(callbackRes.statusCode).toBe(200)
    expect(callbackRes.payload).toContain('downstream-auth:success')
    expect(completeSpy).toHaveBeenCalledWith('abc', 'xyz')

    await app.close()
  })

  it('auto-creates a missing namespace when creating a server from the admin API', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/servers',
      payload: {
        id: 'tavily',
        namespaces: ['default'],
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        enabled: true,
        trustLevel: SourceTrustLevel.Internal,
      },
    })

    expect(res.statusCode).toBe(201)
    expect(getCurrent().namespaces['default']).toBeDefined()
    expect(getCurrent().roles['user']?.allowNamespaces).toContain('default')
    expect(getCurrent().roles['admin']?.allowNamespaces).toContain('default')

    await app.close()
  })

  it('previews imported MCP servers with normalized transport and namespaces to create', async () => {
    const { configRepo, configManager } = createAdminHarness({
      servers: [
        {
          id: 'existing',
          namespaces: ['gmail'],
          transport: 'http',
          url: 'https://existing.example/mcp',
          enabled: true,
          trustLevel: SourceTrustLevel.Verified,
        },
      ],
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/servers/import/preview',
      payload: {
        defaultNamespace: 'default',
        mcpServers: {
          context7: {
            url: 'https://mcp.context7.com/mcp',
            headers: {
              CONTEXT7_API_KEY: 'api',
            },
          },
          existing: {
            url: 'https://duplicate.example/mcp',
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      normalizedServers: [
        expect.objectContaining({
          id: 'context7',
          namespaces: ['default'],
          transport: 'streamable-http',
          headers: { CONTEXT7_API_KEY: 'api' },
          healthcheck: {
            enabled: true,
            intervalSeconds: 30,
          },
        }),
      ],
      conflicts: [
        {
          id: 'existing',
          message: 'server "existing" already exists',
        },
      ],
      validationErrors: [],
      namespacesToCreate: ['default'],
    })

    await app.close()
  })

  it('splits comma-separated defaultNamespace into multiple namespaces on import preview', async () => {
    const { configRepo, configManager } = createAdminHarness(createDefaultAdminConfig(['default', 'code']))
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/servers/import/preview',
      payload: {
        defaultNamespace: 'default,code',
        mcpServers: {
          multi: {
            url: 'https://example.com/mcp',
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().normalizedServers).toEqual([
      expect.objectContaining({
        id: 'multi',
        namespaces: ['default', 'code'],
      }),
    ])

    await app.close()
  })

  it('splits imported stdio command lines into command and args', async () => {
    const { configRepo, configManager } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/servers/import/preview',
      payload: {
        defaultNamespace: 'default',
        mcpServers: {
          tavily: {
            command: 'npx -y mcp-remote "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-dev"',
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().normalizedServers).toEqual([
      expect.objectContaining({
        id: 'tavily',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-dev'],
      }),
    ])

    await app.close()
  })

  it('keeps stdio timeout settings on imported servers', async () => {
    const { configRepo, configManager } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/servers/import/preview',
      payload: {
        defaultNamespace: 'default',
        mcpServers: {
          remote: {
            command: 'npx -y mcp-remote "https://example.com/mcp"',
            stdioTimeoutSeconds: 120,
            stdioInteractiveAuth: { enabled: true },
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().normalizedServers).toEqual([
      expect.objectContaining({
        id: 'remote',
        transport: 'stdio',
        stdioTimeoutSeconds: 120,
        stdioInteractiveAuth: { enabled: true },
      }),
    ])

    await app.close()
  })

  it('skips runtime refresh for imported stdio servers and returns a manual refresh warning', async () => {
    const { configRepo, configManager } = createAdminHarness()
    const refreshTools = vi.fn()
    const registry = {
      refreshTools,
    } as unknown as DownstreamRegistry

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
      registry,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/servers/import',
      payload: {
        defaultNamespace: 'default',
        mcpServers: {
          remote: {
            command: 'npx -y mcp-remote "https://example.com/mcp"',
            stdioTimeoutSeconds: 120,
          },
        },
      },
    })

    expect(res.statusCode).toBe(201)
    expect(refreshTools).not.toHaveBeenCalled()
    expect(res.json().runtimeWarnings).toEqual([
      {
        id: 'remote',
        message: 'Saved without runtime validation. Refresh manually after env is ready.',
      },
    ])

    await app.close()
  })

  it('creates and lists static_key auth tokens via the admin API', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness({
      auth: {
        staticKeys: {
          existing: { userId: 'svc', roles: ['user'] },
        },
      },
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/config/auth/tokens',
      payload: {
        userId: 'inspector',
        roles: ['user', 'admin'],
        token: 'generated-token',
      },
    })

    expect(createRes.statusCode).toBe(201)
    expect(createRes.json()).toEqual({
      version: 1,
      token: 'generated-token',
      userId: 'inspector',
      roles: ['user', 'admin'],
    })
    expect(getCurrent().auth.staticKeys?.['generated-token']).toEqual({
      userId: 'inspector',
      roles: ['user', 'admin'],
    })

    const listRes = await app.inject({
      method: 'GET',
      url: '/admin/config/auth/tokens',
    })

    expect(listRes.statusCode).toBe(200)
    expect(listRes.json()).toEqual({
      summary: {
        clientAuth: 'hybrid',
        clientTokensConfigured: 2,
        adminTokenConfigured: false,
      },
      tokens: expect.arrayContaining([
        {
          token: 'existing',
          userId: 'svc',
          roles: ['user'],
        },
        {
          token: 'generated-token',
          userId: 'inspector',
          roles: ['user', 'admin'],
        },
      ]),
    })

    await app.close()
  })

  it('updates and deletes static_key auth tokens via the admin API', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness({
      auth: {
        staticKeys: {
          managed: { userId: 'svc', roles: ['user'] },
          backup: { userId: 'ops', roles: ['admin'] },
        },
      },
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const updateRes = await app.inject({
      method: 'PUT',
      url: '/admin/config/auth/tokens/managed',
      payload: {
        userId: 'client-app',
        roles: ['admin'],
      },
    })

    expect(updateRes.statusCode).toBe(200)
    expect(getCurrent().auth.staticKeys?.['managed']).toEqual({
      userId: 'client-app',
      roles: ['admin'],
    })

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/admin/config/auth/tokens/managed',
    })

    expect(deleteRes.statusCode).toBe(200)
    expect(deleteRes.json()).toEqual({ version: 1, deleted: true })
    expect(getCurrent().auth.staticKeys?.['managed']).toBeUndefined()

    await app.close()
  })

  it('allows deleting the last client access token', async () => {
    const { configRepo, configManager } = createAdminHarness({
      auth: {
        staticKeys: {
          managed: { userId: 'svc', roles: ['user'] },
        },
      },
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/admin/config/auth/tokens/managed',
    })

    expect(deleteRes.statusCode).toBe(200)
    expect(deleteRes.json()).toEqual({ version: 1, deleted: true })

    await app.close()
  })

  it('allows managing client access tokens with default static_key harness', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/auth/tokens',
      payload: {
        userId: 'dev-user',
        roles: ['user'],
        token: 'dev-token',
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({
      version: 1,
      token: 'dev-token',
      userId: 'dev-user',
      roles: ['user'],
    })
    expect(getCurrent().auth.staticKeys?.['dev-token']).toEqual({
      userId: 'dev-user',
      roles: ['user'],
    })

    await app.close()
  })

  it('drops unknown token profiles when at least one valid profile remains', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness({
      roles: {
        'dev-user': {
          allowNamespaces: ['gmail'],
          denyModes: [],
        },
      },
      namespaces: {
        gmail: {
          allowedRoles: ['dev-user'],
          bootstrapWindowSize: 4,
          candidatePoolSize: 16,
          allowedModes: ['read', 'write'],
        },
      },
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/auth/tokens',
      payload: {
        userId: 'rsb',
        roles: ['user', 'dev-user'],
        token: 'dev-token',
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({
      version: 1,
      token: 'dev-token',
      userId: 'rsb',
      roles: ['dev-user'],
    })
    expect(getCurrent().auth.staticKeys?.['dev-token']).toEqual({
      userId: 'rsb',
      roles: ['dev-user'],
    })

    await app.close()
  })

  it('normalizes tokens with invalid profiles by stripping unknown roles', async () => {
    const { configRepo, configManager } = createAdminHarness({
      roles: {
        'dev-user': {
          allowNamespaces: ['gmail'],
          denyModes: [],
        },
      },
      namespaces: {
        gmail: {
          allowedRoles: ['dev-user'],
          bootstrapWindowSize: 4,
          candidatePoolSize: 16,
          allowedModes: ['read', 'write'],
        },
      },
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/auth/tokens',
      payload: {
        userId: 'rsb',
        roles: ['user'],
        token: 'broken-token',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.token).toBe('broken-token')
    expect(body.roles).toEqual([])

    await app.close()
  })

  it('persists client access tokens to bootstrap.json when configRepo is unavailable', async () => {
    const configManager = createFileModeManager()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configManager,
    })
    await app.ready()

    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/config/auth/tokens',
      payload: {
        userId: 'file-user',
        roles: ['user'],
        token: 'file-token',
      },
    })

    expect(createRes.statusCode).toBe(201)
    const persisted = JSON.parse(readFileSync(join(TMP, 'bootstrap.json'), 'utf8')) as {
      auth?: { staticKeys?: Record<string, { userId: string; roles: string[] }> }
    }
    expect(persisted.auth?.staticKeys?.['file-token']).toEqual({
      userId: 'file-user',
      roles: ['user'],
    })

    const listRes = await app.inject({
      method: 'GET',
      url: '/admin/config/auth/tokens',
    })

    expect(listRes.statusCode).toBe(200)
    expect(listRes.json().tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          token: 'file-token',
          userId: 'file-user',
          roles: ['user'],
        }),
      ])
    )

    const versionsRes = await app.inject({
      method: 'GET',
      url: '/admin/config/versions',
    })

    expect(versionsRes.statusCode).toBe(200)
    expect(versionsRes.json()).toEqual({ versions: [] })

    await app.close()
  })

  it('includes codeMode and allowedOAuthProviders in GET /admin/config/policies', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness({
      allowedOAuthProviders: ['https://issuer.example.com'],
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/admin/config/policies',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().codeMode).toEqual(getCurrent().codeMode)
    expect(res.json().allowedOAuthProviders).toEqual(['https://issuer.example.com'])

    const updateRes = await app.inject({
      method: 'PUT',
      url: '/admin/config/policies',
      payload: {
        ...res.json(),
        allowedOAuthProviders: ['https://issuer.example.com', '*.example.org'],
      },
    })

    expect(updateRes.statusCode).toBe(200)
    expect(getCurrent().allowedOAuthProviders).toEqual([
      'https://issuer.example.com',
      '*.example.org',
    ])

    await app.close()
  })

  it('preserves bearer tokens added after the policies form was loaded', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness({
      auth: {
        staticKeys: {
          existing: { userId: 'svc', roles: ['user'] },
        },
      },
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const initialPoliciesRes = await app.inject({
      method: 'GET',
      url: '/admin/config/policies',
    })

    expect(initialPoliciesRes.statusCode).toBe(200)

    const createTokenRes = await app.inject({
      method: 'POST',
      url: '/admin/config/auth/tokens',
      payload: {
        userId: 'inspector',
        roles: ['admin'],
        token: 'generated-later',
      },
    })

    expect(createTokenRes.statusCode).toBe(201)

    const updateRes = await app.inject({
      method: 'PUT',
      url: '/admin/config/policies',
      payload: {
        ...initialPoliciesRes.json(),
        auth: {
          mode: 'static_key',
          staticKeys: {
            existing: { userId: 'svc', roles: ['user'] },
          },
        },
        allowedOAuthProviders: ['https://issuer.example.com'],
      },
    })

    expect(updateRes.statusCode).toBe(200)
    expect(getCurrent().allowedOAuthProviders).toEqual(['https://issuer.example.com'])
    expect(getCurrent().auth.staticKeys?.['existing']).toEqual({
      userId: 'svc',
      roles: ['user'],
    })
    expect(getCurrent().auth.staticKeys?.['generated-later']).toEqual({
      userId: 'inspector',
      roles: ['admin'],
    })

    await app.close()
  })

  it('persists inbound OAuth policy changes from PUT /admin/config/policies', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/config/policies',
      payload: {
        auth: {
          mode: 'oauth',
          oauth: {
            publicBaseUrl: 'https://gw.example.com',
            authorizationServers: [{ issuer: 'https://issuer.example.com' }],
            allowedBrowserOrigins: ['https://chatgpt.com'],
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(getCurrent().auth).toEqual({
      mode: 'oauth',
      oauth: {
        publicBaseUrl: 'https://gw.example.com',
        authorizationServers: [{ issuer: 'https://issuer.example.com', rolesClaim: 'roles' }],
        allowedBrowserOrigins: ['https://chatgpt.com'],
      },
    })

    await app.close()
  })

  it('promotes oauth policy saves to hybrid when bearer tokens already exist', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness({
      auth: {
        mode: 'static_key',
        staticKeys: {
          existing: { userId: 'svc', roles: ['user'] },
        },
      },
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/config/policies',
      payload: {
        auth: {
          mode: 'oauth',
          oauth: {
            publicBaseUrl: 'https://gw.example.com',
            authorizationServers: [{ issuer: 'https://issuer.example.com' }],
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(getCurrent().auth).toEqual({
      mode: 'hybrid',
      oauth: {
        publicBaseUrl: 'https://gw.example.com',
        authorizationServers: [{ issuer: 'https://issuer.example.com', rolesClaim: 'roles' }],
      },
      staticKeys: {
        existing: { userId: 'svc', roles: ['user'] },
      },
    })

    await app.close()
  })

  it('infers publicBaseUrl from the admin request origin when OAuth is enabled remotely', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/config/policies',
      headers: {
        host: 'gateway.example.test',
        'x-forwarded-proto': 'https',
      },
      payload: {
        auth: {
          mode: 'oauth',
          oauth: {
            publicBaseUrl: '',
            authorizationServers: [{ issuer: 'https://issuer.example.com' }],
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(getCurrent().auth).toEqual({
      mode: 'oauth',
      oauth: {
        publicBaseUrl: 'https://gateway.example.test',
        authorizationServers: [{ issuer: 'https://issuer.example.com', rolesClaim: 'roles' }],
      },
    })

    await app.close()
  })

  it('drops missing namespace profile references while keeping valid ones', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness({
      roles: {
        'dev-user': {
          allowNamespaces: ['gmail', 'dev'],
          denyModes: [],
        },
      },
      namespaces: {
        gmail: {
          allowedRoles: ['user', 'dev-user'],
          bootstrapWindowSize: 4,
          candidatePoolSize: 16,
          allowedModes: ['read', 'write'],
        },
      },
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/config/policies',
      payload: {
        roles: {
          'dev-user': {
            allowNamespaces: ['gmail', 'dev'],
            denyModes: [],
          },
        },
        namespaces: {
          gmail: {
            allowedRoles: ['user', 'dev-user'],
            bootstrapWindowSize: 4,
            candidatePoolSize: 16,
            allowedModes: ['read', 'write'],
          },
          dev: {
            allowedRoles: ['user', 'dev-user'],
            bootstrapWindowSize: 4,
            candidatePoolSize: 16,
            allowedModes: ['read', 'write'],
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(getCurrent().namespaces['gmail']?.allowedRoles).toEqual(['dev-user'])
    expect(getCurrent().namespaces['dev']?.allowedRoles).toEqual(['dev-user'])

    await app.close()
  })

  it('normalizes namespaces by stripping invalid profile references during policy save', async () => {
    const { configRepo, configManager } = createAdminHarness({
      roles: {
        'dev-user': {
          allowNamespaces: ['dev'],
          denyModes: [],
        },
      },
      namespaces: {
        dev: {
          allowedRoles: ['dev-user'],
          bootstrapWindowSize: 4,
          candidatePoolSize: 16,
          allowedModes: ['read', 'write'],
        },
      },
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/config/policies',
      payload: {
        roles: {
          'dev-user': {
            allowNamespaces: ['dev'],
            denyModes: [],
          },
        },
        namespaces: {
          dev: {
            allowedRoles: ['user'],
            bootstrapWindowSize: 4,
            candidatePoolSize: 16,
            allowedModes: ['read', 'write'],
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    const saved = configManager.getAdminConfig()
    expect(saved.namespaces.dev.allowedRoles).toEqual([])

    await app.close()
  })

  it('previews import when payload is a flat server map (no mcpServers key)', async () => {
    const { configRepo, configManager } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/servers/import/preview',
      payload: {
        defaultNamespace: 'default',
        context7: {
          url: 'https://mcp.context7.com/mcp',
          headers: { CONTEXT7_API_KEY: 'k' },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().normalizedServers).toEqual([
      expect.objectContaining({
        id: 'context7',
        namespaces: ['default'],
        transport: 'streamable-http',
      }),
    ])

    await app.close()
  })

  it('imports valid MCP servers atomically and persists headers for HTTP transports', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/servers/import',
      payload: {
        defaultNamespace: 'default',
        mcpServers: {
          context7: {
            url: 'https://mcp.context7.com/mcp',
            headers: {
              CONTEXT7_API_KEY: 'api',
            },
          },
          local_stdio: {
            namespace: 'ops',
            command: 'node',
            args: ['dist/server.js'],
            env: {
              API_KEY: 'secret',
            },
          },
        },
      },
    })

    expect(res.statusCode).toBe(201)
    expect(getCurrent().servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'context7',
          namespaces: ['default'],
          transport: 'streamable-http',
          headers: { CONTEXT7_API_KEY: 'api' },
          healthcheck: {
            enabled: true,
            intervalSeconds: 30,
          },
        }),
        expect.objectContaining({
          id: 'local_stdio',
          namespaces: ['ops'],
          transport: 'stdio',
          command: 'node',
          env: { API_KEY: 'secret' },
          healthcheck: {
            enabled: true,
            intervalSeconds: 30,
          },
        }),
      ])
    )
    expect(getCurrent().namespaces['default']).toBeDefined()
    expect(getCurrent().namespaces['ops']).toBeDefined()

    await app.close()
  })

  it('returns runtime warnings for imported stdio servers without auto-refreshing them', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness()
    const registry = new DownstreamRegistry()
    vi.spyOn(registry, 'refreshTools').mockImplementation(async (id) => {
      if (id === 'tavily') {
        throw new Error('[registry/stdio] Failed to spawn npx: ENOENT')
      }
      return []
    })

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
      registry,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/servers/import',
      payload: {
        defaultNamespace: 'default',
        mcpServers: {
          tavily: {
            command: 'npx -y mcp-remote https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-dev',
          },
        },
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({
      version: 1,
      imported: 1,
      namespacesCreated: ['default'],
      runtimeWarnings: [
        {
          id: 'tavily',
          message: 'Saved without runtime validation. Refresh manually after env is ready.',
        },
      ],
    })
    expect(getCurrent().servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'tavily',
          command: 'npx',
          args: ['-y', 'mcp-remote', 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-dev'],
          healthcheck: {
            enabled: true,
            intervalSeconds: 30,
          },
        }),
      ])
    )

    await app.close()
  })

  it('defaults healthcheck when creating a server from the admin API', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/servers',
      payload: {
        id: 'tavily',
        namespaces: ['default'],
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://example.com/mcp'],
        enabled: true,
        trustLevel: SourceTrustLevel.Verified,
      },
    })

    expect(res.statusCode).toBe(201)
    expect(getCurrent().servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'tavily',
          healthcheck: {
            enabled: true,
            intervalSeconds: 30,
          },
        }),
      ])
    )

    await app.close()
  })

  it('returns runtime health data when a server refresh succeeds', async () => {
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      registry: {
        async listServers() {
          return []
        },
        async getServer() {
          return {
            id: 'fast-mcp-docs',
            namespaces: ['docs'],
            transport: 'http',
            url: 'https://example.com/mcp',
            enabled: true,
            trustLevel: SourceTrustLevel.Verified,
          }
        },
        async getTools() {
          return []
        },
        async refreshTools() {
          return [{ name: 'docs_search' }]
        },
        async checkHealth() {
          return {
            serverId: 'fast-mcp-docs',
            status: 'healthy',
            lastChecked: '2026-03-22T12:00:00.000Z',
            latencyMs: 42,
            error: undefined,
          }
        },
      } as any,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/servers/fast-mcp-docs/refresh',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      toolCount: 1,
      health: 'healthy',
      lastChecked: '2026-03-22T12:00:00.000Z',
      latencyMs: 42,
      authStatus: 'none',
    })

    await app.close()
  })

  it('returns runtime oauth metadata when the auth manager has captured an authorization server', async () => {
    const app = buildServer({ logLevel: 'silent' })
    const getStateSpy = vi.spyOn(downstreamAuthManager, 'getState').mockResolvedValue({
      serverId: 'fast-mcp-docs',
      status: 'authorized' as any,
      message: 'OAuth authorization is required',
      managedSecretConfigured: false,
      authorizationServer: 'https://issuer.example.com',
    } as any)

    await app.register(adminRoutes, {
      registry: {
        async listServers() {
          return [
            {
              id: 'fast-mcp-docs',
              namespaces: ['docs'],
              transport: 'http',
              url: 'https://example.com/mcp',
              enabled: true,
              trustLevel: SourceTrustLevel.Verified,
            },
          ]
        },
        async getServer(id: string) {
          return {
            id,
            namespaces: ['docs'],
            transport: 'http',
            url: 'https://example.com/mcp',
            enabled: true,
            trustLevel: SourceTrustLevel.Verified,
          }
        },
        async getTools() {
          return []
        },
        getHealthState() {
          return undefined
        },
      } as any,
    })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/admin/servers',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().servers).toEqual([
      expect.objectContaining({
        id: 'fast-mcp-docs',
        authStatus: 'authorized',
        authAuthorizationServer: 'https://issuer.example.com',
      }),
    ])

    expect(getStateSpy).toHaveBeenCalledWith('fast-mcp-docs')

    await app.close()
  })

  it('includes the resolved authorization server in the downstream OAuth callback payload', async () => {
    const app = buildServer({ logLevel: 'silent' })
    const completeSpy = vi.spyOn(downstreamAuthManager, 'completeOAuth').mockResolvedValue({
      serverId: 'fast-mcp-docs',
      authorizationServer: 'https://issuer.example.com',
    })

    await app.register(adminRoutes, {
      registry: {
        async refreshTools() {
          return [{ name: 'docs_search' }]
        },
      } as any,
    })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/admin/downstream-auth/callback?state=abc&code=xyz',
    })

    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('downstream-auth:success')
    expect(res.payload).toContain('https://issuer.example.com')
    expect(completeSpy).toHaveBeenCalledWith('abc', 'xyz')

    await app.close()
  })

  it('returns refresh error text with the latest health state when a server refresh fails', async () => {
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      registry: {
        async listServers() {
          return []
        },
        async getServer() {
          return {
            id: 'fast-mcp-docs',
            namespaces: ['docs'],
            transport: 'http',
            url: 'https://example.com/mcp',
            enabled: true,
            trustLevel: SourceTrustLevel.Verified,
          }
        },
        async getTools() {
          return []
        },
        async refreshTools() {
          throw new Error(
            '[registry/http] Server fast-mcp-docs returned non-JSON response from https://gofastmcp.com/mcp'
          )
        },
        async checkHealth() {
          return {
            serverId: 'fast-mcp-docs',
            status: 'unknown',
            lastChecked: '2026-03-22T12:00:00.000Z',
            latencyMs: 18,
            error:
              '[registry/http] Server fast-mcp-docs returned non-JSON response from https://gofastmcp.com/mcp',
          }
        },
        getHealthState() {
          return undefined
        },
      } as any,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/servers/fast-mcp-docs/refresh',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual(
      expect.objectContaining({
        error:
          '[registry/http] Server fast-mcp-docs returned non-JSON response from https://gofastmcp.com/mcp',
        toolCount: 0,
        health: 'unknown',
        lastChecked: '2026-03-22T12:00:00.000Z',
        latencyMs: 18,
      })
    )

    await app.close()
  })

  it('starts and exposes stdio interactive auth sessions through admin routes', async () => {
    const stdioServer = {
      id: 'cloudflare-browser-renderer',
      namespaces: ['default'],
      transport: 'stdio',
      stdioInteractiveAuth: { enabled: true },
      command: 'npx',
      args: ['-y', 'example'],
      enabled: true,
      trustLevel: SourceTrustLevel.Verified,
    }

    const registry = {
      async getServer(id: string) {
        return id === stdioServer.id ? stdioServer : undefined
      },
      async startStdioInteractiveAuth() {
        return {
          serverId: stdioServer.id,
          status: 'pending',
          message: 'Authentication required. Waiting for authorization...',
          url: 'http://127.0.0.1:22393/oauth/callback',
          lastUpdatedAt: '2026-03-22T12:00:00.000Z',
        }
      },
      getStdioInteractiveAuthState() {
        return {
          serverId: stdioServer.id,
          status: 'pending',
          message: 'Authentication required. Waiting for authorization...',
          url: 'http://127.0.0.1:22393/oauth/callback',
          lastUpdatedAt: '2026-03-22T12:00:00.000Z',
        }
      },
      cancelStdioInteractiveAuth() {
        return {
          serverId: stdioServer.id,
          status: 'cancelled',
          message: 'Interactive authentication cancelled.',
          lastUpdatedAt: '2026-03-22T12:01:00.000Z',
        }
      },
    }

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      registry: registry as any,
    })
    await app.ready()

    const startRes = await app.inject({
      method: 'POST',
      url: `/admin/stdio-auth/servers/${stdioServer.id}/start`,
    })
    expect(startRes.statusCode).toBe(200)
    expect(startRes.json()).toEqual(
      expect.objectContaining({
        serverId: stdioServer.id,
        status: 'pending',
        url: 'http://127.0.0.1:22393/oauth/callback',
      })
    )

    const statusRes = await app.inject({
      method: 'GET',
      url: `/admin/stdio-auth/servers/${stdioServer.id}/status`,
    })
    expect(statusRes.statusCode).toBe(200)
    expect(statusRes.json()).toEqual(
      expect.objectContaining({
        serverId: stdioServer.id,
        status: 'pending',
      })
    )

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/admin/stdio-auth/servers/${stdioServer.id}/cancel`,
    })
    expect(cancelRes.statusCode).toBe(200)
    expect(cancelRes.json()).toEqual(
      expect.objectContaining({
        serverId: stdioServer.id,
        status: 'cancelled',
      })
    )

    await app.close()
  })

  it('rejects stdio interactive auth routes when the server is not opted in', async () => {
    const stdioServer = {
      id: 'tavily-remote-mcp',
      namespaces: ['default'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.tavily.com/mcp'],
      enabled: true,
      trustLevel: SourceTrustLevel.Verified,
    }

    const registry = {
      async getServer(id: string) {
        return id === stdioServer.id ? stdioServer : undefined
      },
    }

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      registry: registry as any,
    })
    await app.ready()

    const startRes = await app.inject({
      method: 'POST',
      url: `/admin/stdio-auth/servers/${stdioServer.id}/start`,
    })
    expect(startRes.statusCode).toBe(400)
    expect(startRes.json()).toEqual({
      error: 'Interactive stdio auth is not enabled for this server',
    })

    const statusRes = await app.inject({
      method: 'GET',
      url: `/admin/stdio-auth/servers/${stdioServer.id}/status`,
    })
    expect(statusRes.statusCode).toBe(400)
    expect(statusRes.json()).toEqual({
      error: 'Interactive stdio auth is not enabled for this server',
    })

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/admin/stdio-auth/servers/${stdioServer.id}/cancel`,
    })
    expect(cancelRes.statusCode).toBe(400)
    expect(cancelRes.json()).toEqual({
      error: 'Interactive stdio auth is not enabled for this server',
    })

    await app.close()
  })

  it('stores a managed bearer secret without exposing it in config payloads', async () => {
    process.env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64')
    const credentialStore = new Map<string, any>()
    downstreamAuthManager.setRepository({
      async get(serverId, kind) {
        return credentialStore.get(`${serverId}:${kind}`)
      },
      async save(input) {
        credentialStore.set(`${input.serverId}:${input.kind}`, input)
      },
      async delete(serverId, kind) {
        if (kind) credentialStore.delete(`${serverId}:${kind}`)
      },
      async listByServer(serverId) {
        return [...credentialStore.values()].filter((entry) => entry.serverId === serverId)
      },
    })
    const { configRepo, configManager } = createAdminHarness({
      servers: [
        {
          id: 'example-hosted',
          namespaces: ['default'],
          transport: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          auth: {
            mode: 'bearer',
            source: { type: 'secret' },
          },
          enabled: true,
          trustLevel: SourceTrustLevel.Verified,
          refreshIntervalSeconds: 300,
          healthcheck: { enabled: true, intervalSeconds: 30 },
          discovery: { mode: 'manual' },
        },
      ] as any,
    })

    const registry = {
      async listServers() {
        return configManager.getAdminConfig().servers
      },
      async getServer(id: string) {
        return configManager.getAdminConfig().servers.find((server: any) => server.id === id)
      },
      async getTools() {
        return []
      },
      async refreshTools() {
        return []
      },
      getHealthState() {
        return undefined
      },
      async checkHealth() {
        return undefined
      },
    }
    downstreamAuthManager.syncServers(configManager.getAdminConfig().servers as any)

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, { configRepo, configManager, registry: registry as any })
    await app.ready()

    const saveRes = await app.inject({
      method: 'POST',
      url: '/admin/downstream-auth/servers/example-hosted/bearer-secret',
      payload: { token: 'sb-secret' },
    })

    expect(saveRes.statusCode).toBe(200)
    expect(saveRes.json()).toEqual(
      expect.objectContaining({
        serverId: 'example-hosted',
        managedSecretConfigured: true,
      })
    )

    const listRes = await app.inject({
      method: 'GET',
      url: '/admin/config/servers',
    })

    expect(listRes.statusCode).toBe(200)
    expect(listRes.json().servers).toEqual([
      expect.objectContaining({
        id: 'example-hosted',
        auth: {
          mode: 'bearer',
          source: { type: 'secret' },
        },
      }),
    ])

    await app.close()
  })

  it('exposes downstream auth capabilities and hides managed secret support when encryption is unavailable', async () => {
    const { configRepo, configManager } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
      registry: {
        async listServers() {
          return []
        },
      } as any,
    })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/admin/downstream-auth/capabilities',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      managedSecretsEnabled: false,
      oauthStorageEnabled: false,
    })

    await app.close()
  })

  it('rejects managed bearer auth in server config when managed secret support is unavailable', async () => {
    const { configRepo, configManager } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/servers',
      payload: {
        id: 'example-hosted',
        namespaces: ['default'],
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        auth: {
          mode: 'bearer',
          source: { type: 'secret' },
        },
        enabled: true,
        trustLevel: SourceTrustLevel.Verified,
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual(
      expect.objectContaining({
        error: 'INTERNAL_GATEWAY_ERROR',
        message: 'Invalid downstream auth configuration',
        issues: expect.arrayContaining([
          expect.objectContaining({
            message: 'Managed bearer secrets require SQLite and DOWNSTREAM_AUTH_ENCRYPTION_KEY',
          }),
        ]),
      })
    )

    await app.close()
  })

  it('returns 501 when saving a managed bearer secret without encryption support', async () => {
    const { configRepo, configManager } = createAdminHarness({
      servers: [
        {
          id: 'example-hosted',
          namespaces: ['default'],
          transport: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          auth: {
            mode: 'bearer',
            source: { type: 'secret' },
          },
          enabled: true,
          trustLevel: SourceTrustLevel.Verified,
        },
      ] as any,
    })

    const registry = {
      async listServers() {
        return configManager.getAdminConfig().servers
      },
      async getServer(id: string) {
        return configManager.getAdminConfig().servers.find((server: any) => server.id === id)
      },
      async refreshTools() {
        return []
      },
    }
    downstreamAuthManager.syncServers(configManager.getAdminConfig().servers as any)

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, { configRepo, configManager, registry: registry as any })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/admin/downstream-auth/servers/example-hosted/bearer-secret',
      payload: { token: 'sb-secret' },
    })

    expect(res.statusCode).toBe(501)
    expect(res.json()).toEqual({
      error: 'Managed downstream secrets require SQLite and DOWNSTREAM_AUTH_ENCRYPTION_KEY',
    })

    await app.close()
  })

  it('returns detailed tool catalog entries with effective overrides and token estimates', async () => {
    const toolRecord = makeToolRecord()
    const { configRepo, configManager } = createAdminHarness({
      servers: [
        {
          id: 'docs',
          namespaces: ['default'],
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          enabled: true,
          trustLevel: SourceTrustLevel.Verified,
          toolOverrides: {
            docs_search: {
              description: 'Search curated docs only',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  limit: { type: 'number' },
                },
              },
            },
          },
        },
      ],
    })
    const registry = {
      async listServers() {
        return configManager.getAdminConfig().servers
      },
      async getServer(id: string) {
        return configManager.getAdminConfig().servers.find((server) => server.id === id)
      },
      async getTools() {
        return [toolRecord]
      },
      getHealthState() {
        return undefined
      },
      getToolsByNamespace() {
        return [
          {
            server: configManager.getAdminConfig().servers[0],
            records: [{ ...toolRecord, namespace: 'default' }],
          },
        ]
      },
    } as any

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, { configRepo, configManager, registry })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/admin/tools?serverId=docs',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().tools).toEqual([
      expect.objectContaining({
        name: 'docs_search',
        serverId: 'docs',
        customized: true,
        originalDescription: 'Search the docs',
        effectiveDescription: 'Search curated docs only',
        hasSchemaOverride: true,
        hasDescriptionOverride: true,
      }),
    ])
    expect(res.json().tools[0].totalTokens).toBeGreaterThan(0)
    expect(res.json().tools[0].schemaTokens).toBeGreaterThan(0)

    const schemaRes = await app.inject({
      method: 'GET',
      url: '/admin/servers/docs/schema',
    })

    expect(schemaRes.statusCode).toBe(200)
    expect(schemaRes.json()).toEqual(
      expect.objectContaining({
        summary: expect.objectContaining({
          toolCount: 1,
          customizedTools: 1,
        }),
      })
    )

    await app.close()
  })

  it('persists and reverts tool overrides through the admin API', async () => {
    const toolRecord = makeToolRecord()
    const { configRepo, configManager, getCurrent } = createAdminHarness({
      servers: [
        {
          id: 'docs',
          namespaces: ['default'],
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          enabled: true,
          trustLevel: SourceTrustLevel.Verified,
        },
      ],
    })
    const registry = {
      async listServers() {
        return configManager.getAdminConfig().servers
      },
      async getServer(id: string) {
        return configManager.getAdminConfig().servers.find((server) => server.id === id)
      },
      async getTools() {
        return [toolRecord]
      },
      getToolsByNamespace() {
        return [
          {
            server: configManager.getAdminConfig().servers[0],
            records: [{ ...toolRecord, namespace: 'default' }],
          },
        ]
      },
    } as any

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, { configRepo, configManager, registry })
    await app.ready()

    const updateRes = await app.inject({
      method: 'PUT',
      url: '/admin/tools/docs/docs_search/override',
      payload: {
        description: 'Customized description',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
          },
        },
      },
    })

    expect(updateRes.statusCode).toBe(200)
    expect(getCurrent().servers[0].toolOverrides?.docs_search).toEqual({
      description: 'Customized description',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
        },
      },
    })

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/admin/tools/docs/docs_search/override',
    })

    expect(deleteRes.statusCode).toBe(200)
    expect(getCurrent().servers[0].toolOverrides).toBeUndefined()

    await app.close()
  })

  it('returns namespace summaries with tools/list session metrics and catalog metrics', async () => {
    const toolRecord = makeToolRecord({ namespace: 'gmail' })
    const { configRepo, configManager } = createAdminHarness({
      servers: [
        {
          id: 'docs',
          namespaces: ['gmail'],
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          enabled: true,
          trustLevel: SourceTrustLevel.Verified,
        },
      ],
    })
    const registry = {
      async getTools() {
        return [toolRecord]
      },
      getToolsByNamespace() {
        return [
          {
            server: configManager.getAdminConfig().servers[0],
            records: [{ ...toolRecord, namespace: 'gmail' }],
          },
        ]
      },
    } as any

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, { configRepo, configManager, registry })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/admin/namespaces',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { namespaces: Record<string, unknown>[] }
    expect(body.namespaces).toEqual([
      expect.objectContaining({
        key: 'gmail',
        metrics: expect.objectContaining({
          toolCount: 4,
          customizedTools: 0,
          serverCount: 1,
          totalTokens: expect.any(Number),
          schemaTokens: expect.any(Number),
          initializeInstructionsTokens: expect.any(Number),
          firstTurnEstimatedTokens: expect.any(Number),
        }),
        catalogMetrics: expect.objectContaining({
          toolCount: 1,
          totalTokens: expect.any(Number),
          schemaTokens: expect.any(Number),
        }),
      }),
    ])
    const gmailNs = body.namespaces[0] as {
      metrics: {
        totalTokens: number
        initializeInstructionsTokens: number
        firstTurnEstimatedTokens: number
      }
    }
    expect(gmailNs.metrics.initializeInstructionsTokens).toBeGreaterThan(0)
    expect(gmailNs.metrics.firstTurnEstimatedTokens).toBe(
      gmailNs.metrics.totalTokens + gmailNs.metrics.initializeInstructionsTokens,
    )

    await app.close()
  })

  it('namespace session metrics use full downstream catalog in default gateway mode', async () => {
    const toolRecord = makeToolRecord({ namespace: 'gmail' })
    const base = createDefaultAdminConfig(['gmail'])
    const { configRepo, configManager } = createAdminHarness({
      ...base,
      namespaces: {
        ...base.namespaces,
        gmail: {
          ...base.namespaces.gmail,
          gatewayMode: GatewayMode.Default,
        },
      },
      servers: [
        {
          id: 'docs',
          namespaces: ['gmail'],
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          enabled: true,
          trustLevel: SourceTrustLevel.Verified,
        },
      ],
    })
    const registry = {
      async getTools() {
        return [toolRecord]
      },
      getToolsByNamespace() {
        return [
          {
            server: configManager.getAdminConfig().servers[0],
            records: [{ ...toolRecord, namespace: 'gmail' }],
          },
        ]
      },
    } as any

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, { configRepo, configManager, registry })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/admin/namespaces',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { namespaces: { metrics: { toolCount: number }; catalogMetrics: { toolCount: number } }[] }
    const gmailNs = body.namespaces.find((n) => n.key === 'gmail')
    expect(gmailNs?.metrics.toolCount).toBe(1)
    expect(gmailNs?.catalogMetrics.toolCount).toBe(1)
    expect(gmailNs?.metrics.totalTokens).toBe(gmailNs?.catalogMetrics.totalTokens)
    expect(gmailNs?.metrics.initializeInstructionsTokens).toBe(0)
    expect(gmailNs?.metrics.firstTurnEstimatedTokens).toBe(gmailNs?.metrics.totalTokens)

    await app.close()
  })

  it('deletes a namespace atomically from policies, servers, and role allow-lists', async () => {
    const base = createDefaultAdminConfig(['gmail', 'docs'])
    const { configRepo, configManager, getCurrent } = createAdminHarness({
      namespaces: base.namespaces,
      roles: base.roles,
      starterPacks: base.starterPacks,
      servers: [
        {
          id: 'srv',
          namespaces: ['gmail', 'docs'],
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          enabled: true,
          trustLevel: SourceTrustLevel.Internal,
        },
      ],
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, { configRepo, configManager })
    await app.ready()

    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/namespaces/gmail',
    })

    expect(res.statusCode).toBe(200)
    expect(getCurrent().namespaces['gmail']).toBeUndefined()
    expect(getCurrent().namespaces['docs']).toBeDefined()
    expect(getCurrent().servers[0].namespaces).toEqual(['docs'])
    expect(getCurrent().roles['user']?.allowNamespaces).not.toContain('gmail')
    expect(getCurrent().roles['user']?.allowNamespaces).toContain('docs')

    await app.close()
  })

  it('returns 400 when deleting a namespace would leave a server with zero namespaces', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness({
      servers: [
        {
          id: 'only-gmail',
          namespaces: ['gmail'],
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          enabled: true,
          trustLevel: SourceTrustLevel.Internal,
        },
      ],
    })
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, { configRepo, configManager })
    await app.ready()

    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/namespaces/gmail',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('Cannot delete namespace'),
        serverIds: ['only-gmail'],
      })
    )
    expect(getCurrent().namespaces['gmail']).toBeDefined()

    await app.close()
  })

  it('returns 404 when deleting an unknown namespace', async () => {
    const { configRepo, configManager } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, { configRepo, configManager })
    await app.ready()

    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/namespaces/nonexistent',
    })

    expect(res.statusCode).toBe(404)

    await app.close()
  })

  it('preserves imported namespaces arrays and prefers them over singular namespace', async () => {
    const { configRepo, configManager, getCurrent } = createAdminHarness()
    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {
      configRepo,
      configManager,
    })
    await app.ready()

    const previewRes = await app.inject({
      method: 'POST',
      url: '/admin/config/servers/import/preview',
      payload: {
        mcpServers: {
          context7: {
            namespaces: ['all', 'context7', 'all'],
            namespace: 'legacy-ignored',
            url: 'https://mcp.context7.com/mcp',
          },
        },
      },
    })

    expect(previewRes.statusCode).toBe(200)
    expect(previewRes.json()).toEqual({
      normalizedServers: [
        expect.objectContaining({
          id: 'context7',
          namespaces: ['all', 'context7'],
          transport: 'streamable-http',
        }),
      ],
      conflicts: [],
      validationErrors: [],
      namespacesToCreate: ['all', 'context7'],
    })

    const importRes = await app.inject({
      method: 'POST',
      url: '/admin/config/servers/import',
      payload: {
        mcpServers: {
          context7: {
            namespaces: ['all', 'context7'],
            namespace: 'legacy-ignored',
            url: 'https://mcp.context7.com/mcp',
          },
        },
      },
    })

    expect(importRes.statusCode).toBe(201)
    expect(getCurrent().servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'context7',
          namespaces: ['all', 'context7'],
          transport: 'streamable-http',
        }),
      ])
    )
    expect(getCurrent().namespaces['all']).toBeDefined()
    expect(getCurrent().namespaces['context7']).toBeDefined()

    await app.close()
  })
})
