import type { DownstreamServer } from '../types/server.js'
import type { ToolRecord, ToolcardOverride } from '../types/tools.js'
import { getConfig } from '../config/index.js'
import { projectToPublic } from '../gateway/publish/project.js'
import { generateToolcard } from '../toolcard/index.js'

export type AdminToolEntry = {
  name: string
  serverId: string
  namespace: string
  serverNamespaces: string[]
  riskLevel: string
  customized: boolean
  hasSchemaOverride: boolean
  hasDescriptionOverride: boolean
  originalDescription?: string
  effectiveDescription?: string
  originalInputSchema: Record<string, unknown>
  effectiveInputSchema: Record<string, unknown>
  schemaTokens: number
  totalTokens: number
  /** When false, excluded from namespace token metrics. Omitted/true elsewhere. */
  enabled?: boolean
}

export function estimateSerializedTokens(payload: unknown): number {
  const serialized = JSON.stringify(payload)
  if (!serialized) return 0
  return Math.max(1, Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4))
}

export function buildAdminToolEntry(
  server: DownstreamServer,
  record: ToolRecord,
): AdminToolEntry {
  const override = server.toolOverrides?.[record.name]
  const toolcard = generateToolcard(record, server, override)
  const publicShape = projectToPublic(toolcard, getConfig().selector)

  return {
    name: record.name,
    serverId: server.id,
    namespace: record.namespace,
    serverNamespaces: server.namespaces,
    riskLevel: toolcard.riskLevel,
    customized: hasToolCustomization(override),
    hasSchemaOverride: override?.inputSchema !== undefined,
    hasDescriptionOverride: override?.description !== undefined,
    originalDescription: record.description,
    effectiveDescription: publicShape.description,
    originalInputSchema: record.inputSchema,
    effectiveInputSchema: publicShape.inputSchema,
    schemaTokens: estimateSerializedTokens(publicShape.inputSchema),
    totalTokens: estimateSerializedTokens(publicShape),
  }
}

export function summarizeToolEntries(tools: AdminToolEntry[]) {
  const effective = tools.filter((tool) => tool.enabled !== false)
  return {
    toolCount: effective.length,
    schemaTokens: effective.reduce((sum, tool) => sum + tool.schemaTokens, 0),
    totalTokens: effective.reduce((sum, tool) => sum + tool.totalTokens, 0),
    customizedTools: effective.filter((tool) => tool.customized).length,
  }
}

function hasToolCustomization(override: ToolcardOverride | undefined): boolean {
  if (!override) return false
  return Object.values(override).some((value) => value !== undefined)
}
