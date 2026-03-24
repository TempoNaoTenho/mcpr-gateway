import { SourceTrustLevel, ToolRiskLevel } from '../types/enums.js'
import type { ToolRecord, Toolcard, ToolcardOverride } from '../types/tools.js'
import type { DownstreamServer } from '../types/server.js'
import { sanitizeDescription, sanitizeToolName } from './sanitizer.js'

const INJECTION_PATTERNS = [
  /ignore (previous|prior|above)/i,
  /system (prompt|instruction)/i,
]

const WRITE_PATTERNS = /write|create|update|delete|insert|modify|patch|put|post|remove/i
const ADMIN_PATTERNS = /admin|sudo|execute|run|eval|exec/i

function normalizeSourceTrustLevel(
  trustLevel: DownstreamServer['trustLevel'],
): SourceTrustLevel {
  return trustLevel as SourceTrustLevel
}

export function detectSuspicious(record: ToolRecord): { suspicious: boolean; reason?: string } {
  if (record.description) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(record.description)) {
        return { suspicious: true, reason: `Possible prompt injection: matches pattern ${pattern}` }
      }
    }
  }

  if (record.name.length > 128) {
    return { suspicious: true, reason: 'Tool name exceeds 128 characters' }
  }

  if (/\s/.test(record.name)) {
    return { suspicious: true, reason: 'Tool name contains whitespace' }
  }

  const schema = record.inputSchema
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { suspicious: true, reason: 'inputSchema must be a JSON object' }
  }

  return { suspicious: false }
}

export function deriveRiskLevel(
  name: string,
  _serverId: string,
  serverTrust: SourceTrustLevel,
): ToolRiskLevel {
  if (ADMIN_PATTERNS.test(name)) {
    return ToolRiskLevel.High
  }

  if (WRITE_PATTERNS.test(name)) {
    return serverTrust === SourceTrustLevel.Internal ? ToolRiskLevel.Medium : ToolRiskLevel.High
  }

  return ToolRiskLevel.Low
}

export function generateToolcard(
  record: ToolRecord,
  server: DownstreamServer,
  overrides?: ToolcardOverride,
): Toolcard {
  const now = new Date().toISOString()
  const sourceTrust = normalizeSourceTrustLevel(server.trustLevel)
  const effectiveRecord: ToolRecord = {
    ...record,
    description: overrides?.description ?? record.description,
    inputSchema: overrides?.inputSchema ?? record.inputSchema,
  }

  // Step 1: check overrides for forced quarantine
  if (overrides?.quarantined) {
    return {
      ...record,
      riskLevel: overrides.riskLevel ?? ToolRiskLevel.Low,
      tags: overrides.tags ?? [],
      summary: overrides.summary,
      namespaceHints: overrides.namespaceHints,
      sourceTrust,
      quarantined: true,
      quarantineReason: 'Quarantined by operator override',
      sanitized: true,
      retrievedAt: record.retrievedAt ?? now,
    }
  }

  // Step 2: detect suspicious patterns
  const { suspicious, reason } = detectSuspicious(effectiveRecord)
  if (suspicious) {
    return {
      ...record,
      riskLevel: ToolRiskLevel.High,
      tags: [],
      sourceTrust,
      quarantined: true,
      quarantineReason: reason,
      sanitized: true,
      retrievedAt: record.retrievedAt ?? now,
    }
  }

  // Step 3: sanitize
  const sanitizedName = sanitizeToolName(effectiveRecord.name)
  const sanitizedDescription = sanitizeDescription(effectiveRecord.description)
  const effectiveInputSchema = effectiveRecord.inputSchema

  // Step 4: derive risk level (use override if provided)
  const riskLevel = overrides?.riskLevel ?? deriveRiskLevel(sanitizedName, server.id, sourceTrust)

  // Step 5: derive tags
  const nameTokens = sanitizedName.split(/[_\-.]/).filter(Boolean)
  const trustLabel = sourceTrust.toLowerCase()
  const baseTags = [...new Set([...nameTokens, record.namespace, trustLabel])]
  const tags = overrides?.tags ?? baseTags

  // Step 6: assemble toolcard
  const toolcard: Toolcard = {
    name: sanitizedName,
    description: sanitizedDescription,
    inputSchema: effectiveInputSchema,
    serverId: record.serverId,
    namespace: record.namespace,
    retrievedAt: record.retrievedAt ?? now,
    sanitized: true,
    riskLevel,
    tags,
    summary: overrides?.summary,
    sourceTrust,
    namespaceHints: overrides?.namespaceHints,
    quarantined: false,
  }

  return toolcard
}

export function generateToolcards(
  records: ToolRecord[],
  server: DownstreamServer,
  overrides?: Record<string, ToolcardOverride>,
): Toolcard[] {
  return records.map((record) => generateToolcard(record, server, overrides?.[record.name]))
}
