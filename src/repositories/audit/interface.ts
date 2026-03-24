import type { AuditEvent } from '../../types/interfaces.js'
import type { AuditEventType } from '../../types/enums.js'

export interface AuditQueryFilters {
  sessionId?: string
  userId?: string
  eventType?: AuditEventType
  toolName?: string
  from?: Date
  to?: Date
  limit?: number
  offset?: number
}

export interface AuditQueryResult {
  events: AuditEvent[]
  total: number
  hasMore: boolean
}

export interface IAuditRepository {
  append(event: AuditEvent): Promise<void>
  query(filters: AuditQueryFilters): Promise<AuditQueryResult>
  deleteOlderThan(cutoff: Date): Promise<number>
}
