import type { FastifyBaseLogger } from 'fastify'
import type { OutcomeClass } from '../types/enums.js'

export interface RequestLogFields {
  requestId: string
  sessionId?: string
  namespace: string
  method: string
  userId?: string
  toolName?: string
  downstreamServer?: string
  latencyMs: number
  outcomeClass?: OutcomeClass
  /** Human-readable or JSON-serialized error detail for debugging */
  errorMessage?: string
}

export function logRequest(logger: FastifyBaseLogger | undefined, fields: RequestLogFields, msg: string): void {
  logger?.info(fields, msg)
}

export function logRequestWarn(logger: FastifyBaseLogger | undefined, fields: RequestLogFields, msg: string): void {
  logger?.warn(fields, msg)
}
