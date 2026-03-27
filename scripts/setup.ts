#!/usr/bin/env tsx
/**
 * Interactive setup: checks, optional .env merge, optional bootstrap.json (advanced).
 * Default workflow: SQLite + no bootstrap file (Web UI manages config in the DB).
 * Usage: npm run setup
 */

import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { readDotEnvFile } from './load-dotenv.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CONFIG_DIR = join(ROOT, 'config')

const rl = createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}

type EnvField = {
  key: string
  hint: string
  secret?: boolean
  generate?: 'adminToken' | 'encryptionKey'
}

/** Order matches README / .env.example; interactive prompts only these keys. */
const ENV_FIELDS: EnvField[] = [
  { key: 'HOST', hint: 'HTTP bind (127.0.0.1 local; 0.0.0.0 for Docker/LAN)' },
  { key: 'PORT', hint: 'Port for full-stack dev UI (Vite); gateway uses PORT+1' },
  { key: 'CONFIG_PATH', hint: 'Directory containing bootstrap.json (optional file)' },
  { key: 'LOG_LEVEL', hint: 'Pino log level (e.g. info, debug)' },
  {
    key: 'ADMIN_TOKEN',
    hint: 'Non-empty enables protected /admin; not the login password',
    secret: true,
    generate: 'adminToken',
  },
  { key: 'GATEWAY_ADMIN_USER', hint: 'Admin UI username when ADMIN_TOKEN is set' },
  {
    key: 'GATEWAY_ADMIN_PASSWORD',
    hint: 'Optional password with username; omit for username-only login',
    secret: true,
  },
  {
    key: 'DOWNSTREAM_AUTH_ENCRYPTION_KEY',
    hint: 'Base64 32-byte key for downstream secrets at rest (SQLite)',
    secret: true,
    generate: 'encryptionKey',
  },
  { key: 'SESSION_BACKEND', hint: 'Unset or anything but memory = SQLite; memory = no DB file' },
  { key: 'DATABASE_PATH', hint: 'SQLite file when not memory (default ./data/gateway.db)' },
  { key: 'NODE_ENV', hint: 'Set production to lock down admin unless debug / ADMIN_TOKEN' },
  { key: 'AUDIT_RETENTION_DAYS', hint: 'Default retention for audit prune' },
  { key: 'UI_STATIC_DIR', hint: 'Override built UI path (else ui/dist, ui/build)' },
]

function applyEnvPatches(
  content: string,
  patches: Record<string, string | null | undefined>,
): string {
  const toApply = new Map<string, string | null>()
  for (const [k, v] of Object.entries(patches)) {
    if (v === undefined) continue
    toApply.set(k, v)
  }
  if (toApply.size === 0) return content

  const lines = content.split('\n')
  const out: string[] = []
  const seen = new Set<string>()

  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#')) {
      out.push(line)
      continue
    }
    const eq = t.indexOf('=')
    if (eq === -1) {
      out.push(line)
      continue
    }
    const key = t.slice(0, eq).trim()
    if (!toApply.has(key)) {
      out.push(line)
      continue
    }
    seen.add(key)
    const val = toApply.get(key)
    if (val !== null && val !== '') {
      out.push(`${key}=${val}`)
    }
  }

  for (const [key, val] of toApply) {
    if (!seen.has(key) && val !== null && val !== '') {
      out.push(`${key}=${val}`)
    }
  }

  return out.join('\n')
}

async function checkPort(host: string, port: number, label: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const s = createServer()
      s.once('error', reject)
      s.listen(port, host, () => {
        s.close((err) => (err ? reject(err) : resolve()))
      })
    })
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EADDRINUSE') {
      console.warn(
        `  Port ${port} on ${host} is in use — ${label}. Stop the other process or change PORT.`,
      )
    } else {
      console.warn(`  Could not verify port ${port}: ${err.message}`)
    }
  }
}

function resolveDbPath(vars: Record<string, string>): string | null {
  if ((vars['SESSION_BACKEND'] ?? '').trim() === 'memory') return null
  const rel = (vars['DATABASE_PATH'] ?? '').trim() || './data/gateway.db'
  if (isAbsolute(rel)) return rel
  return join(ROOT, rel)
}

function mask(value: string, secret: boolean | undefined): string {
  if (!value) return '(unset)'
  if (secret) return '********'
  return value
}

async function main(): Promise<void> {
  const isAdvanced = process.argv.includes('--advanced')

  console.log('')
  console.log('MCPR Gateway — Setup')
  console.log('═══════════════════════════')
  console.log('')

  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22 || nodeMajor >= 25 || nodeMajor % 2 === 1) {
    console.error(
      `Node.js 22 or 24 LTS is required for isolated-vm stability. Current runtime: ${process.versions.node}.`
    )
    process.exit(1)
  }

  if (!existsSync(join(ROOT, 'node_modules'))) {
    console.warn('No node_modules found. Run: npm ci')
    console.log('')
  }

  const envPath = join(ROOT, '.env')
  const examplePath = join(ROOT, '.env.example')

  if (!existsSync(envPath)) {
    if (!existsSync(examplePath)) {
      console.error('Missing .env.example at repo root.')
      process.exit(1)
    }
    copyFileSync(examplePath, envPath)
    console.log('Created .env from .env.example')
    console.log('')
  }

  let envContent = readFileSync(envPath, 'utf8')
  let vars = readDotEnvFile(envPath)

  // Returns true if the key has a non-empty value in .env OR in process.env.
  // process.env takes priority in Docker/system deployments.
  function isAlreadySet(key: string): boolean {
    return (vars[key] ?? '').trim() !== '' || (process.env[key] ?? '').trim() !== ''
  }

  // Describes where the value comes from (for display only).
  function configuredIn(key: string): string {
    if ((vars[key] ?? '').trim() !== '') return '(in .env)'
    if ((process.env[key] ?? '').trim() !== '') return '(in environment — will not write to .env)'
    return ''
  }

  const sessionBackend = (vars['SESSION_BACKEND'] ?? '').trim()
  if (sessionBackend === 'memory') {
    console.log('SESSION_BACKEND=memory: no SQLite file; admin saves go to bootstrap.json.')
    console.log('No config versions, no SQLite audit table, no persisted downstream secrets.')
  } else {
    const db = resolveDbPath(vars)
    if (db) {
      if (existsSync(db)) {
        console.log('SQLite database file already exists:')
        console.log(`  ${db}`)
        console.log(
          '  (sessions, config versions, audit, downstream auth metadata — do not delete while the gateway runs.)',
        )
      } else {
        console.log('SQLite will be created on first gateway start:')
        console.log(`  ${db}`)
      }
    }
  }
  console.log('')

  const port = Number(vars['PORT'] ?? process.env['PORT'] ?? 3000)
  const host = (vars['HOST'] ?? process.env['HOST'] ?? '127.0.0.1').trim() || '127.0.0.1'

  console.log('Checking ports used by full-stack dev (npm run dev)…')
  if (Number.isFinite(port) && port >= 1 && port <= 65534) {
    await checkPort(host, port, 'Vite / UI')
    await checkPort(host, port + 1, 'API gateway (PORT+1)')
  } else {
    console.warn('  PORT in .env is not valid; skipped port checks.')
  }
  console.log('')

  // ─── Essential configuration (3 steps) ─────────────────────────────────────

  console.log('Security setup (3 steps)')
  console.log('────────────────────────')
  console.log('')

  const patches: Record<string, string | null | undefined> = {}

  // STEP 1 — Admin panel password
  const KEY_PW = 'GATEWAY_ADMIN_PASSWORD'
  if (isAlreadySet(KEY_PW)) {
    console.log(`  [1/3] ${KEY_PW}  ✓ already configured ${configuredIn(KEY_PW)}`)
  } else {
    console.log(`  [1/3] ${KEY_PW}`)
    console.log('        Password you will type to log into the /admin panel.')
    console.log('')
    let pw = ''
    while (pw === '') {
      pw = (await ask('        Enter admin password (required): ')).trim()
      if (pw === '') console.log('        Password cannot be empty.')
    }
    patches[KEY_PW] = pw
    console.log('        Set. ✓')
  }
  console.log('')

  // STEP 2 — Admin token (security enabler, not a user-facing credential)
  const KEY_AT = 'ADMIN_TOKEN'
  if (isAlreadySet(KEY_AT)) {
    console.log(`  [2/3] ${KEY_AT}  ✓ already configured ${configuredIn(KEY_AT)}`)
  } else {
    const generated = randomBytes(24).toString('base64url')
    console.log(`  [2/3] ${KEY_AT}`)
    console.log('        Enables authentication on /admin routes.')
    console.log('        This is not the login password — it is an internal gateway secret.')
    console.log('')
    const ans = (
      await ask('        Press Enter to use auto-generated token, or paste your own: ')
    ).trim()
    patches[KEY_AT] = ans === '' ? generated : ans
    console.log('        Set. ✓')
  }
  console.log('')

  // STEP 3 — Downstream auth encryption key
  const KEY_EK = 'DOWNSTREAM_AUTH_ENCRYPTION_KEY'
  if (isAlreadySet(KEY_EK)) {
    console.log(`  [3/3] ${KEY_EK}  ✓ already configured ${configuredIn(KEY_EK)}`)
  } else {
    const generated = randomBytes(32).toString('base64')
    console.log(`  [3/3] ${KEY_EK}`)
    console.log('        Encrypts downstream bearer/OAuth credentials stored in SQLite.')
    console.log('        Without this key, managed downstream secrets cannot be saved.')
    console.log('')
    const ans = (
      await ask(
        '        Press Enter to auto-generate (recommended), or paste your own base64-32-byte key: ',
      )
    ).trim()
    patches[KEY_EK] = ans === '' ? generated : ans
    console.log('        Set. ✓')
  }
  console.log('')

  // Write essential patches
  const hasPatches = Object.values(patches).some((v) => v !== undefined)
  if (hasPatches) {
    envContent = applyEnvPatches(envContent, patches)
    writeFileSync(envPath, envContent, 'utf8')
    vars = readDotEnvFile(envPath)
    console.log('Updated .env')
  } else {
    console.log('No changes to .env — all essential vars already configured.')
  }
  console.log('')

  // ─── Advanced mode (all ENV_FIELDS) ────────────────────────────────────────

  if (isAdvanced) {
    console.log('Advanced configuration')
    console.log('──────────────────────')
    console.log('Enter new value, or Enter to keep. Secrets: "g" = generate. "-" = remove key line.')
    console.log('')
    const advancedPatches: Record<string, string | null | undefined> = {}

    for (const field of ENV_FIELDS) {
      const cur = vars[field.key] ?? ''
      const gen =
        field.generate === 'adminToken'
          ? ' / g=generate token'
          : field.generate === 'encryptionKey'
            ? ' / g=generate base64-32-byte'
            : ''
      const line = await ask(
        `${field.key} — ${field.hint}\n  Current: ${mask(cur, field.secret)}${gen}\n  > `,
      )
      const ans = line.trim()
      if (ans === '') continue
      if (ans === '-') {
        advancedPatches[field.key] = null
        continue
      }
      if (ans.toLowerCase() === 'g' && field.generate === 'adminToken') {
        advancedPatches[field.key] = randomBytes(24).toString('base64url')
        continue
      }
      if (ans.toLowerCase() === 'g' && field.generate === 'encryptionKey') {
        advancedPatches[field.key] = randomBytes(32).toString('base64')
        continue
      }
      if (field.key === 'PORT') {
        const n = Number(ans)
        if (!Number.isFinite(n) || n < 1 || n > 65534) {
          console.log('  (skipped invalid PORT)')
          continue
        }
      }
      advancedPatches[field.key] = ans
    }

    if (Object.keys(advancedPatches).length > 0) {
      envContent = applyEnvPatches(envContent, advancedPatches)
      writeFileSync(envPath, envContent, 'utf8')
      vars = readDotEnvFile(envPath)
      console.log('')
      console.log('Updated .env (advanced)')
    } else {
      console.log('')
      console.log('No changes to .env (advanced)')
    }
    console.log('')
  } else {
    console.log('Tip: run `npm run setup -- --advanced` to configure all environment variables.')
    console.log('')
  }

  console.log('Bootstrap file (advanced / GitOps):')
  console.log('  Without config/bootstrap.json the gateway uses defaults + empty server list;')
  console.log('  SQLite stores runtime config after first start. Auth secrets still merge from')
  console.log('  bootstrap.json if that file exists.')
  console.log('')
  const wantBootstrap = (await ask('Create config/bootstrap.json from bootstrap.example.json? [y/N] '))
    .trim()
    .toLowerCase()

  if (wantBootstrap === 'y') {
    const dest = join(CONFIG_DIR, 'bootstrap.json')
    const src = join(CONFIG_DIR, 'bootstrap.example.json')
    if (!existsSync(src)) {
      console.error(`Missing ${src}`)
    } else {
      let ok = true
      if (existsSync(dest)) {
        ok = (await ask('  bootstrap.json exists. Overwrite? [y/N] ')).trim().toLowerCase() === 'y'
      }
      if (ok) {
        copyFileSync(src, dest)
        console.log('  Created config/bootstrap.json')
      }
    }
  }

  console.log('')
  console.log('Next steps:')
  console.log('  npm run dev          # full-stack: Vite (PORT) + gateway (PORT+1)')
  console.log('  npm run dev:gateway  # API only (single PORT)')
  console.log('  npm run build        # UI + gateway bundle for production')
  console.log('')
}

main()
  .catch((err: unknown) => {
    console.error('Setup failed:', err)
    process.exit(1)
  })
  .finally(() => {
    rl.close()
  })
