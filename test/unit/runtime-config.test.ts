import { describe, expect, it, vi } from 'vitest'
import {
  assertRuntimeSecurityConfig,
  getGatewayAdminUserFromEnv,
  hasValidDownstreamAuthEncryptionKey,
} from '../../src/security/runtime-config.js'

describe('runtime security config', () => {
  it('requires GATEWAY_ADMIN_PASSWORD when ADMIN_TOKEN is set', () => {
    expect(() =>
      assertRuntimeSecurityConfig({
        ADMIN_TOKEN: 'secret',
      } as NodeJS.ProcessEnv)
    ).toThrow(/GATEWAY_ADMIN_PASSWORD/)
  })

  it('rejects malformed downstream auth encryption keys', () => {
    expect(() =>
      assertRuntimeSecurityConfig({
        DOWNSTREAM_AUTH_ENCRYPTION_KEY: 'not-base64',
      } as NodeJS.ProcessEnv)
    ).toThrow(/DOWNSTREAM_AUTH_ENCRYPTION_KEY/)
  })

  it('accepts a valid base64 32-byte downstream auth encryption key', () => {
    const env = {
      DOWNSTREAM_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    } as NodeJS.ProcessEnv

    expect(hasValidDownstreamAuthEncryptionKey(env)).toBe(true)
    expect(() => assertRuntimeSecurityConfig(env)).not.toThrow()
  })

  it('warns when production uses the default admin username', () => {
    const warn = vi.fn()

    assertRuntimeSecurityConfig(
      {
        NODE_ENV: 'production',
        ADMIN_TOKEN: 'secret',
        GATEWAY_ADMIN_PASSWORD: 'password',
      } as NodeJS.ProcessEnv,
      { warn }
    )

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mcpgateway'))
  })

  it('returns the default admin username when unset', () => {
    expect(getGatewayAdminUserFromEnv({} as NodeJS.ProcessEnv)).toBe('mcpgateway')
  })
})
