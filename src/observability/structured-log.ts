import type { FastifyBaseLogger } from 'fastify'
import type { OutcomeClass } from '../types/enums.js'

export interface RequestLogFields {
  requestId: string
  sessionId?: string
  namespace: string
  method: string
  userId?: string
  downstreamServer?: string
  latencyMs: number
  outcomeClass?: OutcomeClass
}

export function logRequest(logger: FastifyBaseLogger | undefined, fields: RequestLogFields, msg: string): void {
  logger?.info(fields, msg)
}
