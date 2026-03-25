#!/usr/bin/env tsx
/**
 * Interactive setup script for MCP Session Gateway.
 * Usage: npm run setup
 *
 * Creates config/bootstrap.json from the appropriate example profile.
 * No external dependencies — only Node.js built-ins.
 */

import { existsSync, copyFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CONFIG = join(ROOT, 'config')

const rl = createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}

function checkExists(file: string): boolean {
  return existsSync(join(CONFIG, file))
}

async function confirmOverwrite(file: string): Promise<boolean> {
  const answer = await ask(`  ${file} already exists. Overwrite? [y/N] `)
  return answer.toLowerCase() === 'y'
}

function copy(src: string, dest: string): void {
  copyFileSync(join(CONFIG, src), join(CONFIG, dest))
  console.log(`  ✓ Created config/${dest}`)
}

async function main(): Promise<void> {
  console.log('')
  console.log('MCP Session Gateway — Setup')
  console.log('═══════════════════════════')
  console.log('')

  let shouldWrite = true
  if (checkExists('bootstrap.json')) {
    shouldWrite = await confirmOverwrite('bootstrap.json')
  }

  let profile: '1' | '2' = '1'
  if (shouldWrite) {
    console.log('')
    console.log('Select a configuration profile:')
    console.log(
      '  [1] production — recommended for hosted/shared use; static_key with admin-managed client tokens'
    )
    console.log(
      '  [2] local      — development profile with static_key auth, debug enabled, generous limits'
    )
    console.log('      (this checkout ships one bootstrap.example.json template for both profiles)')
    console.log('')
    const choice = await ask('Profile [1/2, default=1]: ')
    profile = choice.trim() === '2' ? '2' : '1'
  }

  rl.close()

  console.log('')

  if (shouldWrite) {
    const src = 'bootstrap.example.json'
    copy(src, 'bootstrap.json')
  }

  console.log('')
  console.log('Next steps:')
  console.log('')

  if (profile === '1') {
    console.log('  1. Set required environment variables:')
    console.log(
      '       Set ADMIN_TOKEN (enables admin login) and GATEWAY_ADMIN_*, then add client tokens in the Web UI.'
    )
    console.log('')
    console.log('  2. Start the gateway and open the WebUI to configure servers and policies.')
    console.log('')
    console.log('  3. Start the gateway:')
    console.log('       npm run dev')
  } else {
    console.log('  1. Start the gateway and open the WebUI to configure servers and policies.')
    console.log('')
    console.log('  2. Start the gateway:')
    console.log('       npm run dev')
    console.log('')
    console.log('  Tip: create a client token in the WebUI and use it as:')
    console.log('       Authorization: Bearer <issued-token>')
  }

  console.log('')
}

main().catch((err: unknown) => {
  console.error('Setup failed:', err)
  process.exit(1)
})
