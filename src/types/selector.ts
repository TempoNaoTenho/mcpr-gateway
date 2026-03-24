import { z } from 'zod'
import { Mode, RefreshTriggerType, DownstreamHealth } from './enums.js'
import { ToolcardSchema, VisibleToolSchema } from './tools.js'
import { ExecutionOutcomeSchema } from './execution.js'

export const SelectorInputSchema = z.object({
  sessionId: z.string().min(1),
  query: z.string().optional(),
  namespace: z.string().min(1),
  mode: z.nativeEnum(Mode),
  candidates: z.array(ToolcardSchema),
  policyConfig: z.record(z.unknown()),
  recentOutcomes: z.array(ExecutionOutcomeSchema).optional(),
  initialIntentText: z.string().optional(),
  healthStates: z.record(z.nativeEnum(DownstreamHealth)).optional(),
  currentWindow: z.array(VisibleToolSchema).optional(),
  starterPackHints: z.array(z.string()).optional(),
})

export type SelectorInput = z.infer<typeof SelectorInputSchema>

export const SelectorTraceSchema = z.object({
  candidatePoolSize: z.number(),
  filtersApplied: z.array(z.string()),
  penaltiesApplied: z.record(z.number()),
  focus: z
    .object({
      dominantCapability: z.string().optional(),
      reserveSlots: z.number().int().nonnegative(),
    })
    .optional(),
  exclusionReasons: z.array(z.object({
    toolName: z.string(),
    reason: z.string(),
  })),
  rankedList: z.array(z.object({
    toolName: z.string(),
    score: z.number(),
  })),
  windowSizeUsed: z.number(),
  triggerUsed: z.nativeEnum(RefreshTriggerType),
})

export type SelectorTrace = z.infer<typeof SelectorTraceSchema>

export const SelectorDecisionSchema = z.object({
  selected: z.array(VisibleToolSchema),
  reasoning: z.string().optional(),
  triggeredBy: z.nativeEnum(RefreshTriggerType),
  timestamp: z.string().datetime(),
  trace: SelectorTraceSchema.optional(),
})

export type SelectorDecision = z.infer<typeof SelectorDecisionSchema>
