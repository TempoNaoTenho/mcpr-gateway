import { z } from 'zod'
import { ToolRiskLevel, SourceTrustLevel } from './enums.js'

export const ToolSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()),
})

export type ToolSchema = z.infer<typeof ToolSchemaSchema>

export const ToolRecordSchema = ToolSchemaSchema.extend({
  serverId: z.string().min(1),
  namespace: z.string().min(1),
  retrievedAt: z.string().datetime(),
  sanitized: z.boolean(),
})

export type ToolRecord = z.infer<typeof ToolRecordSchema>

export const ToolcardSchema = ToolRecordSchema.extend({
  riskLevel: z.nativeEnum(ToolRiskLevel),
  tags: z.array(z.string()),
  summary: z.string().optional(),
  sourceTrust: z.nativeEnum(SourceTrustLevel),
  examples: z.array(z.string()).optional(),
  namespaceHints: z.array(z.string()).optional(),
  estimatedLatency: z.number().int().nonnegative().optional(),
  quarantined: z.boolean().default(false),
  quarantineReason: z.string().optional(),
})

export type Toolcard = z.infer<typeof ToolcardSchema>

export const ToolcardOverrideSchema = z.object({
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).optional(),
  riskLevel: z.nativeEnum(ToolRiskLevel).optional(),
  tags: z.array(z.string()).optional(),
  summary: z.string().optional(),
  namespaceHints: z.array(z.string()).optional(),
  quarantined: z.boolean().optional(),
})

export type ToolcardOverride = z.infer<typeof ToolcardOverrideSchema>

export const VisibleToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()),
  serverId: z.string().min(1),
  namespace: z.string().min(1),
  riskLevel: z.nativeEnum(ToolRiskLevel),
  tags: z.array(z.string()),
})

export type VisibleTool = z.infer<typeof VisibleToolSchema>

export type PublicTool = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}
