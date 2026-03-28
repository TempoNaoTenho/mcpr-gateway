import { describe, expect, it } from 'vitest'

import {
  applyEnvPatches,
  buildAutomaticEnvPatches,
  getDependencyActions,
  inspectNativeModules,
  shouldRebuildNativeModuleFromError,
  validateNodeRuntime,
} from '../../scripts/setup.mjs'

describe('setup helpers', () => {
  it('accepts Node 24 and rejects other runtimes', () => {
    expect(validateNodeRuntime('24.3.0').ok).toBe(true)
    expect(validateNodeRuntime('22.17.0').ok).toBe(false)
    expect(validateNodeRuntime('25.0.0').ok).toBe(false)
  })

  it('plans dependency installation when root or ui dependencies are missing', () => {
    expect(getDependencyActions({ hasRootDeps: false, hasUiDeps: false })).toEqual({
      installRootDeps: true,
      installUiDeps: false,
    })
    expect(getDependencyActions({ hasRootDeps: true, hasUiDeps: false })).toEqual({
      installRootDeps: false,
      installUiDeps: true,
    })
  })

  it('generates secure local defaults and replaces the legacy admin username', () => {
    let counter = 0
    const fakeRandom = (size: number) => Buffer.alloc(size, ++counter)

    const result = buildAutomaticEnvPatches(
      {
        GATEWAY_ADMIN_USER: 'mcpgateway',
      },
      fakeRandom,
    )

    expect(result.patches['ADMIN_TOKEN']).toBeTruthy()
    expect(result.patches['GATEWAY_ADMIN_PASSWORD']).toBeTruthy()
    expect(result.patches['DOWNSTREAM_AUTH_ENCRYPTION_KEY']).toBeTruthy()
    expect(result.patches['GATEWAY_ADMIN_USER']).toBe('admin')
  })

  it('keeps existing env values untouched on rerun', () => {
    const result = buildAutomaticEnvPatches({
      ADMIN_TOKEN: 'existing-token',
      GATEWAY_ADMIN_USER: 'alice',
      GATEWAY_ADMIN_PASSWORD: 'existing-password',
      DOWNSTREAM_AUTH_ENCRYPTION_KEY: 'existing-key',
    })

    expect(result.patches).toEqual({})
  })

  it('applies env patches without dropping unrelated lines', () => {
    const updated = applyEnvPatches(
      'ADMIN_TOKEN=\nGATEWAY_ADMIN_USER=mcpgateway\nKEEP=value\n',
      {
        ADMIN_TOKEN: 'token',
        GATEWAY_ADMIN_USER: 'admin',
      },
    )

    expect(updated).toContain('ADMIN_TOKEN=token')
    expect(updated).toContain('GATEWAY_ADMIN_USER=admin')
    expect(updated).toContain('KEEP=value')
  })

  it('detects native module ABI mismatches and ignores healthy loads', () => {
    expect(
      shouldRebuildNativeModuleFromError(
        new Error('The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127.')
      )
    ).toBe(true)

    const mismatch = inspectNativeModules((moduleName) => {
      if (moduleName === 'isolated-vm') {
        throw new Error('was compiled against a different Node.js version')
      }
    })

    expect(mismatch.needsRebuild).toBe(true)
    expect(mismatch.failedModules).toContain('isolated-vm')

    const healthy = inspectNativeModules(() => {})
    expect(healthy.ok).toBe(true)
  })
})
