#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

export const NATIVE_MODULES = ['isolated-vm', 'better-sqlite3']

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function shouldRebuildNativeModuleFromError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('NODE_MODULE_VERSION') ||
    message.includes('was compiled against a different Node.js version') ||
    message.includes('Could not locate the bindings file') ||
    message.includes('Module version mismatch')
  )
}

/**
 * @param {string} moduleName
 */
function loadNativeModule(moduleName) {
  const require = createRequire(import.meta.url)
  require(moduleName)
}

/**
 * @param {(moduleName: string) => void} loader
 * @returns {{ ok: boolean; needsRebuild: boolean; failedModules: string[]; message?: string }}
 */
export function inspectNativeModules(loader = loadNativeModule) {
  const failedModules = []

  for (const moduleName of NATIVE_MODULES) {
    try {
      loader(moduleName)
    } catch (error) {
      if (!shouldRebuildNativeModuleFromError(error)) {
        return {
          ok: false,
          needsRebuild: false,
          failedModules: [moduleName],
          message: error instanceof Error ? error.message : String(error),
        }
      }
      failedModules.push(moduleName)
    }
  }

  if (failedModules.length > 0) {
    return {
      ok: false,
      needsRebuild: true,
      failedModules,
      message: `Native modules need rebuild for Node ${process.versions.node}: ${failedModules.join(', ')}`,
    }
  }

  return { ok: true, needsRebuild: false, failedModules: [] }
}

function getNpmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/**
 * @param {string[]} args
 * @param {string} cwd
 */
export function runNpm(args, cwd) {
  console.log(`$ npm ${args.join(' ')}`)
  const result = spawnSync(getNpmCmd(), args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status ?? 1}`)
  }
}

/**
 * @param {{ cwd: string, inspect?: typeof inspectNativeModules, run?: typeof runNpm }} input
 * @returns {{ rebuilt: boolean; failedModules: string[]; message: string }}
 */
export function ensureNativeRuntimeReady(input) {
  const inspect = input.inspect ?? inspectNativeModules
  const run = input.run ?? runNpm

  const nativeState = inspect()
  if (nativeState.ok) {
    return {
      rebuilt: false,
      failedModules: [],
      message: `Native modules are ready for Node ${process.versions.node}.`,
    }
  }

  if (!nativeState.needsRebuild) {
    throw new Error(nativeState.message ?? 'Failed to validate native modules.')
  }

  console.log(nativeState.message)
  console.log('Rebuilding native modules for the active Node version...')
  run(['rebuild', ...NATIVE_MODULES], input.cwd)

  const afterRepair = inspect()
  if (!afterRepair.ok) {
    throw new Error(
      afterRepair.message ??
        'Native modules are still not healthy after automatic rebuild. Run `npm ci` under Node 24 and rebuild the project artifacts.'
    )
  }

  return {
    rebuilt: true,
    failedModules: nativeState.failedModules,
    message: `Rebuilt native modules for Node ${process.versions.node}: ${nativeState.failedModules.join(', ')}`,
  }
}
