import * as path from 'node:path'

/**
 * Command validation utilities for preventing command injection.
 * Provides allowlist checking, dangerous argument detection, and env sanitization.
 */

// Patterns that indicate shell command injection attempts
const DANGEROUS_CHAR_PATTERNS = [
  /;/, // Command chaining
  /\|/, // Pipe
  /&/, // Background/subshell
  /\$\(/, // Command substitution $(...)
  /\$\{/, // Variable expansion ${...}
  /`/, // Backtick command substitution
  /\n/, // Newline
  /\r/, // Carriage return
  /\\'/, // Escaped single quote
  /\\"/, // Escaped double quote
]

// Sensitive environment variable patterns (checked case-insensitively)
const SENSITIVE_VAR_PATTERNS = [
  /TOKEN/i,
  /SECRET/i,
  /KEY/i,
  /PASSWORD/i,
  /AUTH/i,
  /CREDENTIAL/i,
  /PRIVATE/i,
]

// Explicitly stripped environment variable names
const ALWAYS_STRIP_VARS = new Set([
  'ADMIN_TOKEN',
  'DOWNSTREAM_AUTH_ENCRYPTION_KEY',
  'SUPABASE_ACCESS_TOKEN',
])

// Safe environment variables (always allowed)
const SAFE_VAR_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'PWD',
  'LANG',
  'LC_ALL',
  'LANGUAGE',
  'TZ',
  'TERM',
])

// Allowed prefixes for environment variables
const ALLOWED_PREFIXES = ['npm_', 'NODE_', 'MCP_', 'GATEWAY_']

/**
 * Check if a command is allowed based on an allowlist.
 *
 * @param command - The command to validate (can be full path)
 * @param allowlist - List of allowed commands (empty = allow all)
 * @returns true if command is allowed
 *
 * @example
 * isAllowedCommand('/usr/bin/node', ['/usr/bin/node', 'npm']) // true
 * isAllowedCommand('node', ['/usr/bin/node']) // true (basename match)
 * isAllowedCommand('rm', ['/usr/bin/node']) // false
 */
export function isAllowedCommand(command: string, allowlist: string[]): boolean {
  // Empty allowlist = allow all (backwards compatibility)
  if (allowlist.length === 0) {
    return true
  }

  // Exact match
  if (allowlist.includes(command)) {
    return true
  }

  // Basename match (e.g., "node" matches "/usr/bin/node")
  const basename = path.basename(command)
  for (const allowed of allowlist) {
    if (path.basename(allowed) === basename) {
      return true
    }
  }

  return false
}

/**
 * Check if arguments contain dangerous shell injection patterns.
 *
 * @param args - Array of arguments to validate
 * @returns true if any dangerous pattern is detected
 *
 * @example
 * hasDangerousArgs(['--flag', 'value']) // false
 * hasDangerousArgs(['; rm -rf /']) // true
 * hasDangerousArgs(['$(whoami)']) // true
 */
export function hasDangerousArgs(args: string[]): boolean {
  for (const arg of args) {
    for (const pattern of DANGEROUS_CHAR_PATTERNS) {
      if (pattern.test(arg)) {
        return true
      }
    }
  }
  return false
}

/**
 * Sanitize environment variables by removing sensitive data.
 *
 * - ALWAYS strips: ADMIN_TOKEN, DOWNSTREAM_AUTH_ENCRYPTION_KEY, SUPABASE_ACCESS_TOKEN
 * - Strips any var containing: TOKEN, SECRET, KEY, PASSWORD, AUTH, CREDENTIAL, PRIVATE
 * - Keeps: PATH, HOME, USER, SHELL, PWD, LC_*, TERM, TZ
 * - Keeps vars with allowed prefixes: npm_, NODE_, MCP_, GATEWAY_
 *
 * @param env - Environment variables to sanitize
 * @returns Sanitized environment object
 *
 * @example
 * sanitizeEnv({ PATH: '/bin', ADMIN_TOKEN: 'secret', MY_VAR: 'ok' })
 * // Returns: { PATH: '/bin', MY_VAR: 'ok' }
 */
export function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    // Skip undefined/null values
    if (value === undefined || value === null) {
      continue
    }

    // Always strip these regardless of pattern
    if (ALWAYS_STRIP_VARS.has(key)) {
      continue
    }

    // Always keep safe variable names
    if (SAFE_VAR_NAMES.has(key)) {
      sanitized[key] = value
      continue
    }

    // Check against sensitive patterns
    let isSensitive = false
    for (const pattern of SENSITIVE_VAR_PATTERNS) {
      if (pattern.test(key)) {
        isSensitive = true
        break
      }
    }

    if (isSensitive) {
      continue
    }

    // Check allowed prefixes
    let hasAllowedPrefix = false
    for (const prefix of ALLOWED_PREFIXES) {
      if (key.startsWith(prefix)) {
        hasAllowedPrefix = true
        break
      }
    }

    if (hasAllowedPrefix) {
      sanitized[key] = value
      continue
    }

    // Strip LC_* variants if not already handled
    if (key.startsWith('LC_')) {
      sanitized[key] = value
      continue
    }
  }

  return sanitized
}
