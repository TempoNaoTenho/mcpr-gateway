#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyDotEnvFromRoot } from './load-dotenv.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SUPPORTED_NODE_MAJOR = 24
const SECURITY_PLACEHOLDERS = {
  ADMIN_TOKEN: 'change-me-admin-token',
  GATEWAY_ADMIN_USER: 'change-me-admin-user',
  GATEWAY_ADMIN_PASSWORD: 'change-me-admin-password',
  DOWNSTREAM_AUTH_ENCRYPTION_KEY: 'change-me-base64-32-byte-key',
}

function trimToUndefined(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function validateNodeRuntime(version = process.versions.node) {
  const major = Number(version.split('.')[0] ?? '0')
  if (Number.isFinite(major) && major === SUPPORTED_NODE_MAJOR) {
    return { ok: true, message: `Node.js ${version} detected.` }
  }

  return {
    ok: false,
    message: `Node.js 24 LTS is required for MCPR Gateway. Current runtime: ${version}.`,
    remediation:
      'Run `nvm use` (this repo ships `.nvmrc` = 24), then rerun `npm run setup` and `npm start`.',
  }
}

export function hasValidDownstreamKey(value) {
  const trimmed = trimToUndefined(value)
  if (!trimmed) return false
  try {
    return Buffer.from(trimmed, 'base64').length === 32
  } catch {
    return false
  }
}

export function validateRequiredStartEnv(env = process.env) {
  const missing = []

  for (const [key, placeholder] of Object.entries(SECURITY_PLACEHOLDERS)) {
    const value = trimToUndefined(env[key])
    if (!value || value === placeholder) {
      missing.push(key)
    }
  }

  if (!missing.includes('DOWNSTREAM_AUTH_ENCRYPTION_KEY') && !hasValidDownstreamKey(env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'])) {
    missing.push('DOWNSTREAM_AUTH_ENCRYPTION_KEY')
  }

  return missing
}

export function detectBuiltRuntime(root = ROOT, configuredUiDir = process.env['UI_STATIC_DIR']) {
  const gatewayEntry = join(root, 'dist', 'index.js')
  const uiCandidates = [
    configuredUiDir,
    join(root, 'ui', 'dist'),
    join(root, 'ui', 'build'),
  ].filter((value) => Boolean(value))

  let uiDir = null
  for (const candidate of uiCandidates) {
    const resolved = candidate.startsWith('/') ? candidate : resolve(root, candidate)
    if (existsSync(resolved)) {
      uiDir = resolved
      break
    }
  }

  return {
    gatewayEntry,
    uiDir,
    hasGatewayBuild: existsSync(gatewayEntry),
    hasUiBuild: uiDir !== null,
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

export function main() {
  if (!existsSync(join(ROOT, '.env'))) {
    fail('Missing .env. Copy `.env.example` to `.env`, replace the security placeholders, then run `npm start`.')
  }

  applyDotEnvFromRoot(ROOT)

  const runtime = validateNodeRuntime()
  if (!runtime.ok) {
    fail(`${runtime.message}\n${runtime.remediation}`)
  }

  const missing = validateRequiredStartEnv()
  if (missing.length > 0) {
    fail(
      `Missing or placeholder security values in .env: ${missing.join(', ')}.\n` +
        'Set your own values in `.env` before running `npm start`.'
    )
  }

  const buildState = detectBuiltRuntime()
  if (!buildState.hasGatewayBuild || !buildState.hasUiBuild) {
    fail('Built artifacts are missing. Run `npm run setup` before `npm start`.')
  }

  const child = spawn(process.execPath, ['--no-node-snapshot', buildState.gatewayEntry], {
    cwd: ROOT,
    env: process.env,
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
