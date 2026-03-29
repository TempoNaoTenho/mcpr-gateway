import type { ToolCallTelemetry, ToolCallTrace } from '../observability/tool-telemetry.js'

export type RuntimeExecutionTelemetry = ToolCallTelemetry & {
  toolCalls: ToolCallTrace[]
}
