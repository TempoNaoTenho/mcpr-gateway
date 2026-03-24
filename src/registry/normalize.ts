import { ToolSchemaSchema, type ToolRecord, type ToolSchema } from '../types/tools.js'
import type { DownstreamServer } from '../types/server.js'

export function normalizeToolRecord(raw: unknown, server: DownstreamServer): ToolRecord {
  const parsed: ToolSchema = ToolSchemaSchema.parse(raw)
  return {
    name: parsed.name,
    description: parsed.description,
    inputSchema: parsed.inputSchema,
    serverId: server.id,
    namespace: server.namespaces[0],
    retrievedAt: new Date().toISOString(),
    sanitized: false,
  }
}
