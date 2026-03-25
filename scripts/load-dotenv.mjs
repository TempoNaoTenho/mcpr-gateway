/**
 * Minimal .env parser (no deps). Used by dev-all and setup.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function parseDotEnvLines(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of text.split('\n')) {
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
    out[k] = v
  }
  return out
}

/**
 * @param {string} absPath
 * @returns {Record<string, string>}
 */
export function readDotEnvFile(absPath) {
  if (!existsSync(absPath)) return {}
  return parseDotEnvLines(readFileSync(absPath, 'utf8'))
}

/**
 * Merge keys from `.env` at root into `process.env` only when the variable is unset (same as many dotenv loaders).
 * @param {string} root
 */
export function applyDotEnvFromRoot(root) {
  const p = join(root, '.env')
  for (const [k, v] of Object.entries(readDotEnvFile(p))) {
    if (process.env[k] === undefined) process.env[k] = v
  }
}
