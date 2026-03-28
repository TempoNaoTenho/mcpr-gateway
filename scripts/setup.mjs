#!/usr/bin/env node
/**
 * Idempotent local setup:
 * - validates Node 24 LTS
 * - installs missing root/ui dependencies
 * - repairs native module ABI mismatches after Node switches
 * - creates/fills .env with secure local defaults
 * - offers optional advanced editing/bootstrap creation
 */

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { readDotEnvFile } from './load-dotenv.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CONFIG_DIR = join(ROOT, 'config')
const ENV_PATH = join(ROOT, '.env')
const ENV_EXAMPLE_PATH = join(ROOT, '.env.example')
const NATIVE_MODULES = ['isolated-vm', 'better-sqlite3']
const SUPPORTED_NODE_MAJOR = 24
const DEFAULT_ADMIN_USER = 'admin'
const LEGACY_DEFAULT_ADMIN_USER = 'mcpgateway'

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
 * @param {Record<string, string>} vars
 * @param {(size: number) => Buffer} randomSource
 * @returns {{
 *   patches: Record<string, string>;
 *   generated: Record<string, string>;
 *   keptExisting: string[];
 * }}
 */
export function buildAutomaticEnvPatches(vars, randomSource = randomBytes) {
  /** @type {Record<string, string>} */
  const patches = {}
  /** @type {Record<string, string>} */
  const generated = {}
  /** @type {string[]} */
  const keptExisting = []

  const currentUser = (vars['GATEWAY_ADMIN_USER'] ?? '').trim()
  const ensureValue = (key, value) => {
    const current = (vars[key] ?? '').trim()
    if (current !== '') {
      keptExisting.push(key)
      return
    }
    patches[key] = value
    generated[key] = value
  }

  ensureValue('ADMIN_TOKEN', randomSource(24).toString('base64url'))
  ensureValue('GATEWAY_ADMIN_PASSWORD', randomSource(18).toString('base64url'))
  ensureValue('DOWNSTREAM_AUTH_ENCRYPTION_KEY', randomSource(32).toString('base64'))

  if (currentUser === '' || currentUser === LEGACY_DEFAULT_ADMIN_USER) {
    patches['GATEWAY_ADMIN_USER'] = DEFAULT_ADMIN_USER
    if (currentUser !== DEFAULT_ADMIN_USER) {
      generated['GATEWAY_ADMIN_USER'] = DEFAULT_ADMIN_USER
    }
  } else {
    keptExisting.push('GATEWAY_ADMIN_USER')
  }

  return { patches, generated, keptExisting }
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

/**
 * @param {string} moduleName
 */
function loadNativeModule(moduleName) {
  const require = createRequire(import.meta.url)
  require(moduleName)
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

function getNpmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/**
 * @param {string[]} args
 * @param {string} root
 */
function runNpm(args, root = ROOT) {
  console.log(`$ npm ${args.join(' ')}`)
  const result = spawnSync(getNpmCmd(), args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status ?? 1}`)
  }
}

/**
 * @param {string} root
 */
function ensureEnvFile(root = ROOT) {
  const envPath = join(root, '.env')
  const examplePath = join(root, '.env.example')
  if (existsSync(envPath)) return false
  if (!existsSync(examplePath)) {
    throw new Error('Missing .env.example at repo root.')
  }
  copyFileSync(examplePath, envPath)
  return true
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
 * @param {string} host
 * @param {number} port
 * @param {string} label
 * @returns {Promise<void>}
 */
async function checkPort(host, port, label) {
  try {
    await new Promise((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(port, host, () => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    })
  } catch (error) {
    const err = /** @type {NodeJS.ErrnoException} */ (error)
    if (err.code === 'EADDRINUSE') {
      console.warn(`  Port ${port} on ${host} is in use - ${label}. Stop the other process or change PORT.`)
    } else {
      console.warn(`  Could not verify port ${port}: ${err.message}`)
    }
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
 * @returns {Promise<void>}
 */
async function checkPortsForDev(vars) {
  const port = Number(vars['PORT'] ?? process.env['PORT'] ?? 3000)
  const host = (vars['HOST'] ?? process.env['HOST'] ?? '127.0.0.1').trim() || '127.0.0.1'

  console.log('Checking ports used by full-stack dev (npm run dev)...')
  if (!Number.isFinite(port) || port < 1 || port > 65534) {
    console.warn('  PORT in .env is not valid; skipped port checks.')
    return
  }

  await checkPort(host, port, 'Vite / UI')
  await checkPort(host, port + 1, 'API gateway (PORT+1)')
}

/**
 * @param {Record<string, string>} vars
 * @param {Record<string, string>} generated
 */
function printNextSteps(vars, generated) {
  const host = (vars['HOST'] ?? process.env['HOST'] ?? '127.0.0.1').trim() || '127.0.0.1'
  const port = Number(vars['PORT'] ?? process.env['PORT'] ?? 3000)
  const uiUrl = `http://${host}:${port}`
  const apiUrl = `http://${host}:${port + 1}`
  const adminUser = (vars['GATEWAY_ADMIN_USER'] ?? DEFAULT_ADMIN_USER).trim() || DEFAULT_ADMIN_USER

  console.log('')
  console.log('Local dev is ready.')
  console.log(`  UI:  ${uiUrl}`)
  console.log(`  API: ${apiUrl}`)
  console.log('  `npm run dev` uses Vite on the UI port and the gateway on PORT+1.')
  console.log('  `/ui/` is the static build path used by `npm run build` and Docker.')
  console.log('')
  console.log('Admin login:')
  console.log(`  Username: ${adminUser}`)
  if (generated['GATEWAY_ADMIN_PASSWORD']) {
    console.log(`  Password: ${generated['GATEWAY_ADMIN_PASSWORD']}`)
  } else {
    console.log('  Password: unchanged in .env')
  }
  console.log('')
  console.log('Next steps:')
  console.log('  npm run dev')
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

  const createdEnv = ensureEnvFile(ROOT)
  if (createdEnv) {
    console.log('Created .env from .env.example')
    console.log('')
  }

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

  const nativeState = inspectNativeModules()
  if (nativeState.needsRebuild) {
    console.log(nativeState.message)
    console.log('Rebuilding native modules for the active Node version...')
    runNpm(['rebuild', ...NATIVE_MODULES])
  } else if (!nativeState.ok) {
    throw new Error(nativeState.message ?? 'Failed to validate native modules.')
  }

  const nativeStateAfterRepair = inspectNativeModules()
  if (!nativeStateAfterRepair.ok) {
    throw new Error(
      nativeStateAfterRepair.message ?? 'Native modules are still not healthy after dependency preparation.'
    )
  }

  let envContent = readFileSync(ENV_PATH, 'utf8')
  let vars = readDotEnvFile(ENV_PATH)

  const { patches, generated } = buildAutomaticEnvPatches(vars)
  if (Object.keys(patches).length > 0) {
    envContent = applyEnvPatches(envContent, patches)
    writeFileSync(ENV_PATH, envContent, 'utf8')
    vars = readDotEnvFile(ENV_PATH)
    console.log('Updated .env with local defaults for first run.')
  } else {
    console.log('.env already contains the required local setup values.')
  }

  console.log('')
  printStorageSummary(vars)
  console.log('')
  await checkPortsForDev(vars)

  if (isAdvanced) {
    vars = await runAdvancedMode(vars)
  } else {
    console.log('')
    console.log('Tip: run `npm run setup -- --advanced` to customize env vars or create bootstrap.json.')
  }

  printNextSteps(vars, generated)
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
