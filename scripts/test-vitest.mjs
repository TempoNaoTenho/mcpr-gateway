#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureNativeRuntimeReady } from './native-runtime.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SUPPORTED_NODE_MAJOR = 24
const NO_SNAPSHOT_FLAG = '--no-node-snapshot'

function validateNodeRuntime(version = process.versions.node) {
  const major = Number(version.split('.')[0] ?? '0')
  if (Number.isFinite(major) && major === SUPPORTED_NODE_MAJOR) {
    return { ok: true, message: `Node.js ${version} detected.` }
  }

  return {
    ok: false,
    message: `Node.js 24 LTS is required for MCPR Gateway tests. Current runtime: ${version}.`,
    remediation: 'Run `nvm use` (this repo ships `.nvmrc` = 24), then rerun `npm test`.',
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function withNoNodeSnapshot(current = process.env['NODE_OPTIONS'] ?? '') {
  if (current.includes(NO_SNAPSHOT_FLAG)) return current.trim()
  return `${NO_SNAPSHOT_FLAG} ${current}`.trim()
}

function hasNoNodeSnapshot() {
  return process.execArgv.includes(NO_SNAPSHOT_FLAG) || (process.env['NODE_OPTIONS'] ?? '').includes(NO_SNAPSHOT_FLAG)
}

function relaunchWithNoNodeSnapshot() {
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: withNoNodeSnapshot(),
    },
    stdio: 'inherit',
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}

function main() {
  const runtime = validateNodeRuntime()
  if (!runtime.ok) {
    fail(`${runtime.message}\n${runtime.remediation}`)
  }

  if (!hasNoNodeSnapshot()) {
    relaunchWithNoNodeSnapshot()
    return
  }

  try {
    ensureNativeRuntimeReady({ cwd: ROOT })
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}\n` +
        'Automatic native rebuild failed. Run `npm ci` under Node 24, then rerun `npm test`.'
    )
  }

  const require = createRequire(import.meta.url)
  const vitestCli = require.resolve('vitest/vitest.mjs')
  const args = process.argv.slice(2)
  const child = spawn(process.execPath, [vitestCli, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: withNoNodeSnapshot(),
    },
    stdio: 'inherit',
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
