import { and, desc, gte, lte, eq, sql } from 'drizzle-orm'
import type { SqliteDb } from '../../db/index.js'
import { auditEvents } from '../../db/adapters/sqlite/schema.js'
import type { IAuditRepository, AuditQueryFilters, AuditQueryResult } from './interface.js'
import type { AuditEvent } from '../../types/interfaces.js'

export class SqliteAuditRepository implements IAuditRepository {
  constructor(private readonly db: SqliteDb) {}

  async append(event: AuditEvent): Promise<void> {
    const now = Date.now()

    const sessionId = 'sessionId' in event ? event.sessionId : null
    const userId    = 'userId'    in event ? event.userId    : null
    const namespace = 'namespace' in event ? event.namespace : null
    const toolName  = 'toolName'  in event ? event.toolName  : null
    const serverId  = 'downstreamServer' in event
      ? (event as { downstreamServer: string }).downstreamServer
      : 'serverId' in event ? (event as { serverId: string }).serverId : null
    const outcome   = 'outcome'   in event ? String(event.outcome) : null
    const latencyMs = 'latencyMs' in event ? (event as { latencyMs: number }).latencyMs : null

    this.db.insert(auditEvents).values({
      eventType:   event.type,
      sessionId,
      userId,
      namespace,
      toolName,
      serverId,
      outcome,
      latencyMs,
      payloadJson: JSON.stringify(event),
      occurredAt:  now,
    }).run()
  }

  async query(filters: AuditQueryFilters): Promise<AuditQueryResult> {
    const limit  = filters.limit  ?? 50
    const offset = filters.offset ?? 0

    const whereClause = and(
      filters.sessionId ? eq(auditEvents.sessionId, filters.sessionId) : undefined,
      filters.userId    ? eq(auditEvents.userId,    filters.userId)    : undefined,
      filters.eventType ? eq(auditEvents.eventType, filters.eventType) : undefined,
      filters.toolName  ? eq(auditEvents.toolName,  filters.toolName)  : undefined,
      filters.from ? gte(auditEvents.occurredAt, filters.from.getTime()) : undefined,
      filters.to   ? lte(auditEvents.occurredAt, filters.to.getTime())   : undefined,
    )

    const countRows = this.db
      .select({ count: sql<number>`COUNT(*)`.as('count') })
      .from(auditEvents)
      .where(whereClause)
      .all()

    const total = Number(countRows[0]?.count ?? 0)

    const rows = this.db
      .select()
      .from(auditEvents)
      .where(whereClause)
      .orderBy(desc(auditEvents.occurredAt))
      .limit(limit)
      .offset(offset)
      .all()

    const events = rows.map(row => JSON.parse(row.payloadJson) as AuditEvent)

    return { events, total, hasMore: offset + rows.length < total }
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const cutoffMs = cutoff.getTime()

    const toDelete = this.db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(lte(auditEvents.occurredAt, cutoffMs))
      .all()

    if (toDelete.length === 0) return 0

    this.db.delete(auditEvents).where(lte(auditEvents.occurredAt, cutoffMs)).run()

    return toDelete.length
  }
}
