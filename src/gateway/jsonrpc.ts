import { z } from 'zod'
import { GatewayError, GatewayErrorCode } from '../types/errors.js'

export const JsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.string(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
})

export type JsonRpcBody = {
  jsonrpc: string
  id: number | string | null
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcEnvelope =
  | JsonRpcBody
  | {
      jsonrpc: string
      method: string
      params?: Record<string, unknown>
    }

export function isNotificationMethod(method: string): boolean {
  return method.startsWith('notifications/')
}

export function isJsonRpcRequest(body: JsonRpcEnvelope): body is JsonRpcBody {
  return 'id' in body
}

export function parseJsonRpcEnvelope(body: unknown): JsonRpcEnvelope {
  const bodyResult = JsonRpcEnvelopeSchema.safeParse(body)
  if (!bodyResult.success) {
    throw new GatewayError(
      GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
      'Invalid JSON-RPC body',
      bodyResult.error.issues
    )
  }

  const envelope = bodyResult.data
  if (!isNotificationMethod(envelope.method) && envelope.id === undefined) {
    throw new GatewayError(GatewayErrorCode.INTERNAL_GATEWAY_ERROR, 'Invalid JSON-RPC body', [
      {
        code: 'invalid_type',
        expected: 'number | string | null',
        received: 'undefined',
        path: ['id'],
        message: 'Required',
      },
    ])
  }

  return envelope as JsonRpcEnvelope
}
