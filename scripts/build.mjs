#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureNativeRuntimeReady } from './native-runtime.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SUPPORTED_NODE_MAJOR = 24

export function validateNodeRuntime(version = process.versions.node) {
  const major = Number(version.split('.')[0] ?? '0')
  if (Number.isFinite(major) && major === SUPPORTED_NODE_MAJOR) {
    return { ok: true, message: `Node.js ${version} detected.` }
  }

  return {
    ok: false,
    message: `Node.js 24 LTS is required for MCPR Gateway. Current runtime: ${version}.`,
    remediation:
      'Run `nvm use` (this repo ships `.nvmrc` = 24), then rerun `npm ci` and `npm run build`.',
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function runScript(scriptName) {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', scriptName], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }

    if ((code ?? 0) !== 0) {
      process.exit(code ?? 1)
      return
    }

    if (scriptName === 'build:ui') {
      runScript('build:gateway')
    } else {
      process.exit(0)
    }
  })
}

export function main() {
  const runtime = validateNodeRuntime()
  if (!runtime.ok) {
    fail(`${runtime.message}\n${runtime.remediation}`)
  }

  try {
    ensureNativeRuntimeReady({ cwd: ROOT })
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}\n` +
        'Automatic native rebuild failed. Run `npm ci` under Node 24, then retry `npm run build`.'
    )
  }

  runScript('build:ui')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
