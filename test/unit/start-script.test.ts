import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  detectBuiltRuntime,
  hasValidDownstreamKey,
  validateNodeRuntime,
  validateRequiredStartEnv,
} from '../../scripts/start.mjs'

describe('start script helpers', () => {
  it('accepts Node 24 and rejects other runtimes', () => {
    expect(validateNodeRuntime('24.4.0').ok).toBe(true)
    expect(validateNodeRuntime('22.17.0').ok).toBe(false)
  })

  it('requires explicit non-placeholder security values for the built runtime', () => {
    expect(
      validateRequiredStartEnv({
        ADMIN_TOKEN: 'change-me-admin-token',
        GATEWAY_ADMIN_USER: 'change-me-admin-user',
        GATEWAY_ADMIN_PASSWORD: 'change-me-admin-password',
        DOWNSTREAM_AUTH_ENCRYPTION_KEY: 'change-me-base64-32-byte-key',
      } as NodeJS.ProcessEnv)
    ).toEqual([
      'ADMIN_TOKEN',
      'GATEWAY_ADMIN_USER',
      'GATEWAY_ADMIN_PASSWORD',
      'DOWNSTREAM_AUTH_ENCRYPTION_KEY',
    ])
  })

  it('accepts valid security values and a valid downstream key', () => {
    const env = {
      ADMIN_TOKEN: 'real-admin-token',
      GATEWAY_ADMIN_USER: 'alice',
      GATEWAY_ADMIN_PASSWORD: 'real-password',
      DOWNSTREAM_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    } as NodeJS.ProcessEnv

    expect(validateRequiredStartEnv(env)).toEqual([])
    expect(hasValidDownstreamKey(env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'])).toBe(true)
  })

  it('rejects malformed downstream keys even when present', () => {
    const env = {
      ADMIN_TOKEN: 'real-admin-token',
      GATEWAY_ADMIN_USER: 'alice',
      GATEWAY_ADMIN_PASSWORD: 'real-password',
      DOWNSTREAM_AUTH_ENCRYPTION_KEY: 'not-base64',
    } as NodeJS.ProcessEnv

    expect(validateRequiredStartEnv(env)).toEqual(['DOWNSTREAM_AUTH_ENCRYPTION_KEY'])
  })

  it('detects built runtime artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpr-start-build-'))
    mkdirSync(join(root, 'dist'), { recursive: true })
    mkdirSync(join(root, 'ui', 'build'), { recursive: true })
    writeFileSync(join(root, 'dist', 'index.js'), 'console.log("gateway")\n')

    expect(detectBuiltRuntime(root)).toEqual({
      gatewayEntry: join(root, 'dist', 'index.js'),
      uiDir: join(root, 'ui', 'build'),
      hasGatewayBuild: true,
      hasUiBuild: true,
    })

    rmSync(root, { recursive: true, force: true })
  })
})
