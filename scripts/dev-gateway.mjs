#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0')

if (!Number.isFinite(nodeMajor) || nodeMajor < 22 || nodeMajor >= 25 || nodeMajor % 2 === 1) {
  console.error(
    `dev:gateway requires Node 22 or 24 LTS for isolated-vm stability. Current runtime: ${process.versions.node}.`
  )
  process.exit(1)
}

const noSnapshotFlag = '--no-node-snapshot'
const currentNodeOptions = process.env['NODE_OPTIONS'] ?? ''
const nextNodeOptions = currentNodeOptions.includes(noSnapshotFlag)
  ? currentNodeOptions.trim()
  : `${noSnapshotFlag} ${currentNodeOptions}`.trim()

const tsxBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
if (!existsSync(tsxBin)) {
  console.error('Missing tsx binary. Run: npm ci')
  process.exit(1)
}

const child = spawn(tsxBin, ['watch', 'src/index.ts'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_OPTIONS: nextNodeOptions,
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

