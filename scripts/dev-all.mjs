#!/usr/bin/env node
/**
 * Full-stack dev: Vite binds to HOST/PORT from .env; gateway binds to PORT+1.
 * Sets GATEWAY_PROXY_TARGET so the UI proxies /admin and /health to the API.
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadDotEnv() {
  const p = join(root, '.env')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i === -1) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1)
    }
    if (process.env[k] === undefined) process.env[k] = v
  }
}

loadDotEnv()

const port = Number(process.env['PORT'] ?? 3000)
const host = process.env['HOST'] ?? '127.0.0.1'
if (!Number.isFinite(port) || port < 1 || port > 65534) {
  console.error('dev-all: PORT must be a number between 1 and 65534')
  process.exit(1)
}
const backendPort = port + 1
const proxyTarget = `http://127.0.0.1:${backendPort}`

const gwEnv = { ...process.env, PORT: String(backendPort), HOST: host }
const uiEnv = {
  ...process.env,
  PORT: String(port),
  HOST: host,
  GATEWAY_PROXY_TARGET: proxyTarget,
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const gw = spawn(npmCmd, ['run', 'dev'], {
  cwd: root,
  env: gwEnv,
  stdio: 'inherit',
})

const ui = spawn(npmCmd, ['run', 'dev', '--prefix', 'ui'], {
  cwd: root,
  env: uiEnv,
  stdio: 'inherit',
})

function killAll(sig) {
  try {
    gw.kill(sig)
  } catch {
    /* ignore */
  }
  try {
    ui.kill(sig)
  } catch {
    /* ignore */
  }
}

let shuttingDown = false
function onChildExit(name, code, signal) {
  if (shuttingDown) return
  shuttingDown = true
  if (signal) {
    console.error(`dev-all: ${name} exited on ${signal}`)
  } else if (code !== 0 && code !== null) {
    console.error(`dev-all: ${name} exited with code ${code}`)
  }
  killAll('SIGTERM')
  process.exit(code === 0 || code === null ? 0 : code ?? 1)
}

gw.on('exit', (code, signal) => onChildExit('gateway', code, signal))
ui.on('exit', (code, signal) => onChildExit('ui', code, signal))

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    killAll(sig)
    setTimeout(() => process.exit(130), 500).unref()
  })
}
