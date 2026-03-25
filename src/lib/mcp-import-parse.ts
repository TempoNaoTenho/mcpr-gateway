/**
 * Shared parsing / coercion for MCP server JSON import (admin API + UI).
 * Tolerates trailing commas, markdown fences, outer junk, and Cursor-style fragments.
 */

export type CoerceMcpImportOk = {
  ok: true
  defaultNamespace?: string
  mcpServers: Record<string, unknown>
}

export type CoerceMcpImportErr = {
  ok: false
  message: string
}

export type CoerceMcpImportResult = CoerceMcpImportOk | CoerceMcpImportErr

const RESERVED_TOP_LEVEL_KEYS = new Set([
  'defaultNamespace',
  'mcpServers',
  'auth',
  'roles',
  'namespaces',
  'servers',
  'policies',
  'version',
  'comment',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function stripMarkdownFence(text: string): string {
  let s = text.trim()
  if (!s.startsWith('```')) return s
  const lines = s.split('\n')
  lines.shift()
  const last = lines[lines.length - 1]
  if (last !== undefined && last.trim() === '```') lines.pop()
  return lines.join('\n').trim()
}

/**
 * `{ ... }` balanced from `openBraceIndex` (respects strings and escapes).
 */
export function extractBalancedJsonObject(text: string, openBraceIndex: number): string | null {
  if (
    openBraceIndex < 0
    || openBraceIndex >= text.length
    || text.charAt(openBraceIndex) !== '{'
  ) {
    return null
  }
  let depth = 0
  let inString = false
  let escape = false
  for (let i = openBraceIndex; i < text.length; i++) {
    const c = text[i]!
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(openBraceIndex, i + 1)
    }
  }
  return null
}

/**
 * First `{ ... }` balanced for JSON-like text (respects strings and escapes).
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  return extractBalancedJsonObject(text, start)
}

function stripTrailingCommas(json: string): string {
  return json.replace(/,(\s*[}\]])/g, '$1')
}

function parseJsonLenient(text: string): unknown {
  let t = text.trim()
  const attempts: string[] = [t]

  if (!t.startsWith('{')) {
    attempts.push(`{${t}}`)
  }

  for (const candidate of attempts) {
    let current = candidate
    for (let i = 0; i < 8; i++) {
      try {
        return JSON.parse(current)
      } catch {
        const next = stripTrailingCommas(current)
        if (next === current) break
        current = next
      }
    }
  }

  const extracted = extractFirstJsonObject(t)
  if (extracted && extracted !== t) {
    return parseJsonLenient(extracted)
  }

  throw new SyntaxError('Invalid JSON')
}

function preprocessImportText(raw: string): string {
  let s = stripMarkdownFence(raw)
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1)
  }
  return s
}

const MCP_SERVERS_KEY = '"mcpServers"'

/**
 * Raw text value of the `mcpServers` object (balanced `{ ... }`), if present.
 * Handles concatenated objects where the first `{...}` is not the mcpServers wrapper.
 */
function findMcpServersObjectText(text: string): string | null {
  let pos = 0
  while (pos <= text.length) {
    const i = text.indexOf(MCP_SERVERS_KEY, pos)
    if (i < 0) return null
    const afterKey = i + MCP_SERVERS_KEY.length
    const m = text.slice(afterKey).match(/^\s*:\s*/)
    if (!m) {
      pos = i + 1
      continue
    }
    let j = afterKey + m[0].length
    while (j < text.length && /\s/.test(text.charAt(j))) j++
    if (j >= text.length || text.charAt(j) !== '{') {
      pos = i + 1
      continue
    }
    return extractBalancedJsonObject(text, j)
  }
  return null
}

function looksLikeServerEntry(value: Record<string, unknown>): boolean {
  const url = value['url']
  const command = value['command']
  const transport = value['transport']
  if (typeof url === 'string' && url.trim().length > 0) return true
  if (typeof command === 'string' && command.trim().length > 0) return true
  if (transport === 'stdio' || transport === 'http' || transport === 'streamable-http') {
    return typeof url === 'string' || typeof command === 'string'
  }
  return false
}

function inferMcpServersMap(payload: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (RESERVED_TOP_LEVEL_KEYS.has(key)) continue
    if (Array.isArray(value)) continue
    if (isRecord(value) && looksLikeServerEntry(value)) {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

type ExtractMcpServersResult =
  | { found: true; defaultNamespace?: string; mcpServers: Record<string, unknown> }
  | { found: false; message: string }

function extractMcpServersFromRecord(payload: Record<string, unknown>): ExtractMcpServersResult {
  const defaultNamespace = trimToUndefined(payload['defaultNamespace'])
  const direct = payload['mcpServers']

  if (isRecord(direct)) {
    return { found: true, defaultNamespace, mcpServers: direct }
  }

  const inferred = inferMcpServersMap(payload)
  if (inferred) {
    return { found: true, defaultNamespace, mcpServers: inferred }
  }

  return {
    found: false,
    message:
      'No MCP servers found. Use an `mcpServers` object, or a map of server id → config (with `url` or `command`).',
  }
}

/**
 * Parse raw pasted/config text into a coerced import shape.
 */
export function parseMcpImportText(raw: string): CoerceMcpImportResult {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { ok: false, message: 'Import JSON is empty' }
  }

  const pre = preprocessImportText(raw)

  let parsed: unknown | undefined
  try {
    parsed = parseJsonLenient(pre)
  } catch {
    parsed = undefined
  }

  let noMcpMessage =
    'No MCP servers found. Use an `mcpServers` object, or a map of server id → config (with `url` or `command`).'

  if (parsed !== undefined) {
    if (!isRecord(parsed)) {
      return { ok: false, message: 'Import JSON must be an object at the top level' }
    }
    const extracted = extractMcpServersFromRecord(parsed)
    if (extracted.found) {
      return {
        ok: true,
        defaultNamespace: extracted.defaultNamespace,
        mcpServers: extracted.mcpServers,
      }
    }
    noMcpMessage = extracted.message
  }

  const mcpObjText = findMcpServersObjectText(pre)
  if (mcpObjText) {
    try {
      const inner = parseJsonLenient(mcpObjText)
      if (isRecord(inner)) {
        return { ok: true, mcpServers: inner }
      }
    } catch {
      // fall through
    }
  }

  if (parsed === undefined) {
    return { ok: false, message: 'Import JSON is invalid' }
  }

  return { ok: false, message: noMcpMessage }
}

/**
 * Coerce an already-parsed JSON body (object) or a string body from the import API.
 */
export function coerceMcpImport(body: unknown): CoerceMcpImportResult {
  if (typeof body === 'string') {
    return parseMcpImportText(body)
  }
  if (!isRecord(body)) {
    return { ok: false, message: 'Import body must be a JSON object' }
  }

  const extracted = extractMcpServersFromRecord(body)
  if (!extracted.found) {
    return { ok: false, message: extracted.message }
  }
  return {
    ok: true,
    defaultNamespace: extracted.defaultNamespace,
    mcpServers: extracted.mcpServers,
  }
}

/**
 * Pretty-print canonical shape for the import textarea (namespace stays in the separate UI field).
 */
export function formatMcpImportForEditor(mcpServers: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers }, null, 2)
}
