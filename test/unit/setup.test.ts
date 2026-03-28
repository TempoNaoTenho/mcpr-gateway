import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  applyEnvPatches,
  detectBuildArtifacts,
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

  it('detects when the production build artifacts exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpr-setup-build-'))
    mkdirSync(join(root, 'dist'), { recursive: true })
    mkdirSync(join(root, 'ui', 'build'), { recursive: true })
    writeFileSync(join(root, 'dist', 'index.js'), 'console.log("gateway")\n')

    expect(detectBuildArtifacts(root)).toEqual({
      hasGatewayBuild: true,
      hasUiBuild: true,
      gatewayEntry: join(root, 'dist', 'index.js'),
      uiDir: join(root, 'ui', 'build'),
    })

    rmSync(root, { recursive: true, force: true })
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

  it('reports missing build artifacts when gateway or UI output is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpr-setup-missing-build-'))

    expect(detectBuildArtifacts(root)).toEqual({
      hasGatewayBuild: false,
      hasUiBuild: false,
      gatewayEntry: join(root, 'dist', 'index.js'),
      uiDir: null,
    })

    rmSync(root, { recursive: true, force: true })
  })
})
