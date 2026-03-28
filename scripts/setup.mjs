#!/usr/bin/env node
/**
 * Idempotent local setup:
 * - validates Node 24 LTS
 * - installs missing root/ui dependencies
 * - repairs native module ABI mismatches after Node switches
 * - requires an explicit .env owned by the user
 * - builds the production UI + gateway artifacts
 * - offers optional advanced editing/bootstrap creation
 */

import { randomBytes } from 'node:crypto'
import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { readDotEnvFile } from './load-dotenv.mjs'
import {
  ensureNativeRuntimeReady,
  inspectNativeModules,
  runNpm,
  shouldRebuildNativeModuleFromError,
} from './native-runtime.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CONFIG_DIR = join(ROOT, 'config')
const ENV_PATH = join(ROOT, '.env')
const SUPPORTED_NODE_MAJOR = 24

const rl = createInterface({ input: process.stdin, output: process.stdout })

/**
 * @param {string} question
 * @returns {Promise<string>}
 */
function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve))
}

/**
 * @param {string} version
 * @returns {{ ok: boolean; major: number; message: string; remediation?: string }}
 */
export function validateNodeRuntime(version = process.versions.node) {
  const major = Number(version.split('.')[0] ?? '0')
  if (Number.isFinite(major) && major === SUPPORTED_NODE_MAJOR) {
    return {
      ok: true,
      major,
      message: `Node.js ${version} detected.`,
    }
  }

  return {
    ok: false,
    major,
    message: `Node.js 24 LTS is required for MCPR Gateway. Current runtime: ${version}.`,
    remediation:
      'Run `nvm use` (this repo ships `.nvmrc` = 24), or switch your Node manager to 24 LTS, then rerun `npm run setup`.',
  }
}

/**
 * @param {string} content
 * @param {Record<string, string | null | undefined>} patches
 * @returns {string}
 */
export function applyEnvPatches(content, patches) {
  const toApply = new Map()
  for (const [key, value] of Object.entries(patches)) {
    if (value === undefined) continue
    toApply.set(key, value)
  }
  if (toApply.size === 0) return content

  const lines = content.split('\n')
  const out = []
  const seen = new Set()

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line)
      continue
    }

    const eq = trimmed.indexOf('=')
    if (eq === -1) {
      out.push(line)
      continue
    }

    const key = trimmed.slice(0, eq).trim()
    if (!toApply.has(key)) {
      out.push(line)
      continue
    }

    seen.add(key)
    const value = toApply.get(key)
    if (value !== null && value !== '') {
      out.push(`${key}=${value}`)
    }
  }

  for (const [key, value] of toApply) {
    if (!seen.has(key) && value !== null && value !== '') {
      out.push(`${key}=${value}`)
    }
  }

  return out.join('\n')
}

/**
 * @param {{ hasRootDeps: boolean; hasUiDeps: boolean }} input
 * @returns {{ installRootDeps: boolean; installUiDeps: boolean }}
 */
export function getDependencyActions(input) {
  return {
    installRootDeps: !input.hasRootDeps,
    installUiDeps: input.hasRootDeps && !input.hasUiDeps,
  }
}

/**
 * @param {string} root
 * @returns {{ hasRootDeps: boolean; hasUiDeps: boolean }}
 */
function detectDependencyState(root = ROOT) {
  return {
    hasRootDeps: existsSync(join(root, 'node_modules')),
    hasUiDeps: existsSync(join(root, 'ui', 'node_modules')),
  }
}

/**
 * @param {string} root
 */
function assertEnvFileExists(root = ROOT) {
  if (!existsSync(join(root, '.env'))) {
    throw new Error('Missing .env. Copy `.env.example` to `.env`, edit the security variables, then rerun `npm run setup`.')
  }
}

/**
 * @param {Record<string, string>} vars
 * @returns {string | null}
 */
function resolveDbPath(vars) {
  if ((vars['SESSION_BACKEND'] ?? '').trim() === 'memory') return null
  const rel = (vars['DATABASE_PATH'] ?? '').trim() || './data/gateway.db'
  if (isAbsolute(rel)) return rel
  return join(ROOT, rel)
}

/**
 * @param {string} root
 * @param {string | undefined} configuredUiDir
 * @returns {{ hasGatewayBuild: boolean; hasUiBuild: boolean; gatewayEntry: string; uiDir: string | null }}
 */
export function detectBuildArtifacts(root = ROOT, configuredUiDir) {
  const gatewayEntry = join(root, 'dist', 'index.js')
  const uiCandidates = [
    configuredUiDir,
    join(root, 'ui', 'dist'),
    join(root, 'ui', 'build'),
  ].filter((value) => Boolean(value))

  for (const candidate of uiCandidates) {
    const resolved = candidate.startsWith('/') ? candidate : resolve(root, candidate)
    if (existsSync(resolved)) {
      return {
        hasGatewayBuild: existsSync(gatewayEntry),
        hasUiBuild: true,
        gatewayEntry,
        uiDir: resolved,
      }
    }
  }

  return {
    hasGatewayBuild: existsSync(gatewayEntry),
    hasUiBuild: false,
    gatewayEntry,
    uiDir: null,
  }
}

/**
 * @param {Record<string, string>} vars
 */
function printStorageSummary(vars) {
  const sessionBackend = (vars['SESSION_BACKEND'] ?? '').trim()
  if (sessionBackend === 'memory') {
    console.log('SESSION_BACKEND=memory: no SQLite file; admin saves go to bootstrap.json.')
    console.log('No config versions, no SQLite audit table, no persisted downstream secrets.')
    return
  }

  const dbPath = resolveDbPath(vars)
  if (!dbPath) return
  if (existsSync(dbPath)) {
    console.log('SQLite database file already exists:')
    console.log(`  ${dbPath}`)
    console.log(
      '  (sessions, config versions, audit, downstream auth metadata - do not delete while the gateway runs.)'
    )
    return
  }

  console.log('SQLite will be created on first gateway start:')
  console.log(`  ${dbPath}`)
}

/**
 * @param {Record<string, string>} vars
 */
function printNextSteps(vars) {
  const host = (vars['HOST'] ?? process.env['HOST'] ?? '127.0.0.1').trim() || '127.0.0.1'
  const port = Number(vars['PORT'] ?? process.env['PORT'] ?? 3000)

  console.log('')
  console.log('Built installation is ready.')
  console.log(`  App: http://${host}:${port}`)
  console.log('  `npm start` serves the built UI and MCP gateway on the same port.')
  console.log('')
  console.log('Next steps:')
  console.log('  1. Confirm the security variables in `.env` are set to your own values.')
  console.log('  2. npm start')
  console.log('  3. npm run dev   # optional contributor workflow (Vite UI + gateway)')
  console.log('  npm run setup -- --advanced   # optional custom env/bootstrap editing')
}

/**
 * @param {Record<string, string>} vars
 * @returns {Promise<Record<string, string>>}
 */
async function runAdvancedMode(vars) {
  const envPath = join(ROOT, '.env')
  let envContent = readFileSync(envPath, 'utf8')
  /** @type {Record<string, string | null | undefined>} */
  const advancedPatches = {}

  /** @type {Array<{ key: string; hint: string; secret?: boolean; generate?: 'adminToken' | 'encryptionKey' }>} */
  const fields = [
    { key: 'HOST', hint: 'HTTP bind (127.0.0.1 local; 0.0.0.0 for Docker/LAN)' },
    { key: 'PORT', hint: 'Port for full-stack dev UI (Vite); gateway uses PORT+1' },
    { key: 'CONFIG_PATH', hint: 'Directory containing bootstrap.json (optional file)' },
    { key: 'LOG_LEVEL', hint: 'Pino log level (e.g. info, debug)' },
    { key: 'ADMIN_TOKEN', hint: 'Non-empty enables protected /admin', secret: true, generate: 'adminToken' },
    { key: 'GATEWAY_ADMIN_USER', hint: 'Admin UI username' },
    { key: 'GATEWAY_ADMIN_PASSWORD', hint: 'Admin UI password', secret: true },
    {
      key: 'DOWNSTREAM_AUTH_ENCRYPTION_KEY',
      hint: 'Base64 32-byte key for downstream secrets at rest',
      secret: true,
      generate: 'encryptionKey',
    },
    { key: 'SESSION_BACKEND', hint: 'Unset or anything but memory = SQLite; memory = no DB file' },
    { key: 'DATABASE_PATH', hint: 'SQLite file when not memory (default ./data/gateway.db)' },
    { key: 'NODE_ENV', hint: 'Use production for publishable setup' },
    { key: 'AUDIT_RETENTION_DAYS', hint: 'Default retention for audit prune' },
    { key: 'UI_STATIC_DIR', hint: 'Override built UI path (else ui/dist, ui/build)' },
  ]

  console.log('')
  console.log('Advanced configuration')
  console.log('----------------------')
  console.log('Enter new value, or Enter to keep. Secrets: "g" = generate. "-" = remove key line.')
  console.log('')

  for (const field of fields) {
    const current = vars[field.key] ?? ''
    const masked = field.secret && current ? '********' : current || '(unset)'
    const generateHint =
      field.generate === 'adminToken'
        ? ' / g=generate token'
        : field.generate === 'encryptionKey'
          ? ' / g=generate base64-32-byte'
          : ''
    const answer = (
      await ask(`${field.key} - ${field.hint}\n  Current: ${masked}${generateHint}\n  > `)
    ).trim()

    if (answer === '') continue
    if (answer === '-') {
      advancedPatches[field.key] = null
      continue
    }
    if (answer.toLowerCase() === 'g' && field.generate === 'adminToken') {
      advancedPatches[field.key] = randomBytes(24).toString('base64url')
      continue
    }
    if (answer.toLowerCase() === 'g' && field.generate === 'encryptionKey') {
      advancedPatches[field.key] = randomBytes(32).toString('base64')
      continue
    }
    if (field.key === 'PORT') {
      const port = Number(answer)
      if (!Number.isFinite(port) || port < 1 || port > 65534) {
        console.log('  (skipped invalid PORT)')
        continue
      }
    }
    advancedPatches[field.key] = answer
  }

  if (Object.keys(advancedPatches).length > 0) {
    envContent = applyEnvPatches(envContent, advancedPatches)
    writeFileSync(envPath, envContent, 'utf8')
    console.log('')
    console.log('Updated .env (advanced)')
  } else {
    console.log('')
    console.log('No changes to .env (advanced)')
  }

  const wantBootstrap = (await ask('Create config/bootstrap.json from bootstrap.example.json? [y/N] '))
    .trim()
    .toLowerCase()
  if (wantBootstrap === 'y') {
    const dest = join(CONFIG_DIR, 'bootstrap.json')
    const src = join(CONFIG_DIR, 'bootstrap.example.json')
    if (!existsSync(src)) {
      throw new Error(`Missing ${src}`)
    }

    let overwrite = true
    if (existsSync(dest)) {
      overwrite = (await ask('  bootstrap.json exists. Overwrite? [y/N] ')).trim().toLowerCase() === 'y'
    }
    if (overwrite) {
      copyFileSync(src, dest)
      console.log('  Created config/bootstrap.json')
    }
  }

  return readDotEnvFile(envPath)
}

export async function main(argv = process.argv.slice(2)) {
  const isAdvanced = argv.includes('--advanced')

  console.log('')
  console.log('MCPR Gateway - Setup')
  console.log('====================')
  console.log('')

  const runtime = validateNodeRuntime()
  if (!runtime.ok) {
    console.error(runtime.message)
    if (runtime.remediation) console.error(runtime.remediation)
    process.exit(1)
  }

  console.log(runtime.message)
  console.log('')

  assertEnvFileExists(ROOT)

  let dependencyState = detectDependencyState(ROOT)
  const dependencyActions = getDependencyActions(dependencyState)

  if (dependencyActions.installRootDeps) {
    console.log('Installing root dependencies with `npm ci`...')
    runNpm(['ci'])
    dependencyState = detectDependencyState(ROOT)
  }

  if (!dependencyState.hasUiDeps) {
    console.log('Installing UI dependencies...')
    runNpm(['--prefix', 'ui', 'ci'])
    dependencyState = detectDependencyState(ROOT)
  }

  if (!dependencyState.hasRootDeps || !dependencyState.hasUiDeps) {
    throw new Error('Dependency installation did not complete successfully.')
  }

  ensureNativeRuntimeReady({ cwd: ROOT })

  let vars = readDotEnvFile(ENV_PATH)

  console.log('')
  printStorageSummary(vars)

  if (isAdvanced) {
    vars = await runAdvancedMode(vars)
  } else {
    console.log('')
    console.log('Tip: run `npm run setup -- --advanced` to customize `.env` or create `config/bootstrap.json`.')
  }

  console.log('')
  console.log('Building production assets...')
  runNpm(['--prefix', 'ui', 'run', 'build'])
  runNpm(['run', 'build:gateway'])

  const buildState = detectBuildArtifacts(ROOT, vars['UI_STATIC_DIR'])
  if (!buildState.hasGatewayBuild || !buildState.hasUiBuild) {
    throw new Error('Production build artifacts are incomplete. Re-run `npm run setup` and inspect the build output above.')
  }

  console.log('')
  console.log('Verified production artifacts:')
  console.log(`  Gateway bundle: ${buildState.gatewayEntry}`)
  console.log(`  UI build:       ${buildState.uiDir}`)

  printNextSteps(vars)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch((error) => {
      console.error('')
      console.error('Setup failed:', error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
    .finally(() => {
      rl.close()
    })
}
