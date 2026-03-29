import { OutcomeClass } from '../types/enums.js'

export type ToolCallTelemetry = {
  latencyMs: number
  requestBytes: number
  responseBytes: number
  requestTokensEstimate: number
  responseTokensEstimate: number
  totalTokensEstimate: number
}

export type ToolCallTrace = ToolCallTelemetry & {
  toolName: string
  serverId: string
  outcome: OutcomeClass
}

export function estimateSerializedTokens(payload: unknown): number {
  const serialized = safeSerialize(payload)
  if (!serialized) return 0
  return Math.max(1, Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4))
}

export function estimatePayloadBytes(payload: unknown): number {
  const serialized = safeSerialize(payload)
  if (!serialized) return 0
  return Buffer.byteLength(serialized, 'utf8')
}

export function buildToolCallTelemetry(
  requestPayload: unknown,
  responsePayload: unknown,
  latencyMs: number,
): ToolCallTelemetry {
  const requestBytes = estimatePayloadBytes(requestPayload)
  const responseBytes = estimatePayloadBytes(responsePayload)
  const requestTokensEstimate = estimateSerializedTokens(requestPayload)
  const responseTokensEstimate = estimateSerializedTokens(responsePayload)

  return {
    latencyMs,
    requestBytes,
    responseBytes,
    requestTokensEstimate,
    responseTokensEstimate,
    totalTokensEstimate: requestTokensEstimate + responseTokensEstimate,
  }
}

function safeSerialize(payload: unknown): string | undefined {
  if (payload === undefined) return undefined
  try {
    return JSON.stringify(payload)
  } catch {
    return JSON.stringify(String(payload))
  }
}
