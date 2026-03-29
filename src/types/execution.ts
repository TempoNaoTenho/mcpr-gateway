import { z } from 'zod'
import { OutcomeClass } from './enums.js'

export const ToolCallTelemetrySchema = z.object({
  latencyMs: z.number().nonnegative(),
  requestBytes: z.number().nonnegative(),
  responseBytes: z.number().nonnegative(),
  requestTokensEstimate: z.number().nonnegative(),
  responseTokensEstimate: z.number().nonnegative(),
  totalTokensEstimate: z.number().nonnegative(),
})

export const ExecutionOutcomeSchema = z.object({
  toolName: z.string().min(1),
  serverId: z.string().min(1),
  sessionId: z.string().min(1),
  outcome: z.nativeEnum(OutcomeClass),
  result: z.unknown().optional(),
  error: z.string().optional(),
  telemetry: ToolCallTelemetrySchema.optional(),
  durationMs: z.number().nonnegative(),
  timestamp: z.string().datetime(),
})

export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>
