import { z } from 'zod'
import { Mode, RefreshTriggerType, SessionStatus } from './enums.js'
import { ExecutionOutcomeSchema } from './execution.js'
import { SelectorDecisionSchema } from './selector.js'
import { VisibleToolSchema } from './tools.js'

const RefreshHistoryEntrySchema = z.object({
  triggeredBy: z.nativeEnum(RefreshTriggerType),
  timestamp: z.string().datetime(),
  toolCount: z.number().int().nonnegative(),
})

export type RefreshHistoryEntry = z.infer<typeof RefreshHistoryEntrySchema>

const SessionFocusProfileSchema = z.object({
  dominantCapability: z.string().min(1).optional(),
  recentCapabilities: z.array(z.string().min(1)).default([]),
  totalSignals: z.number().int().nonnegative().default(0),
  updatedAt: z.string().datetime(),
})

export type SessionFocusProfile = z.infer<typeof SessionFocusProfileSchema>

export const SessionStateSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  namespace: z.string().min(1),
  mode: z.nativeEnum(Mode),
  status: z.nativeEnum(SessionStatus),
  toolWindow: z.array(VisibleToolSchema),
  createdAt: z.string().datetime(),
  lastActiveAt: z.string().datetime(),
  refreshCount: z.number().int().nonnegative(),
  resolvedPolicy: z
    .object({
      starterPackKey: z.string().optional(),
      namespacePolicy: z.record(z.unknown()),
    })
    .optional(),
  lastSelectorDecision: SelectorDecisionSchema.optional(),
  recentOutcomes: z.array(ExecutionOutcomeSchema).default([]),
  initialIntentText: z.string().min(1).optional(),
  refreshHistory: z.array(RefreshHistoryEntrySchema).default([]),
  focusProfile: SessionFocusProfileSchema.optional(),
  pendingToolListChange: z.boolean().default(false),
  clientCapabilities: z
    .object({
      supportsToolListChanged: z.boolean(),
    })
    .optional(),
  /** Negotiated Streamable HTTP MCP protocol version (initialize). */
  mcpProtocolVersion: z.string().min(1).optional(),
})

export type SessionState = z.infer<typeof SessionStateSchema>
