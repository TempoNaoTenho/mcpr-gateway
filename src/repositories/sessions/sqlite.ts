import { eq, and, or, lt, gte, isNull, isNotNull, asc, sql } from 'drizzle-orm'
import type { SqliteDb } from '../../db/index.js'
import { sessions } from '../../db/adapters/sqlite/schema.js'
import type { ISessionRepository, PaginationOptions } from './interface.js'
import type { SessionId, Namespace } from '../../types/identity.js'
import { SessionStateSchema } from '../../types/session.js'
import type { SessionState } from '../../types/session.js'

function parseState(stateJson: string): SessionState {
  return SessionStateSchema.parse(JSON.parse(stateJson))
}

export class SqliteSessionRepository implements ISessionRepository {
  private cleanupTimer: NodeJS.Timeout | null = null
  private ttlMs = 0

  constructor(private readonly db: SqliteDb) {}

  async get(id: SessionId): Promise<SessionState | undefined> {
    const now = Date.now()
    const rows = this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1).all()

    if (rows.length === 0) return undefined
    const row = rows[0]

    if (row.expiresAt !== null && row.expiresAt < now) {
      await this.delete(id)
      return undefined
    }

    return parseState(row.stateJson)
  }

  async set(id: SessionId, state: SessionState): Promise<void> {
    const lastActiveMs = new Date(state.lastActiveAt).getTime()
    const expiresAt = this.ttlMs > 0 ? lastActiveMs + this.ttlMs : null

    this.db
      .insert(sessions)
      .values({
        id,
        userId: state.userId,
        namespace: state.namespace,
        mode: state.mode,
        status: state.status,
        stateJson: JSON.stringify(state),
        createdAt: new Date(state.createdAt).getTime(),
        lastActive: lastActiveMs,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: sessions.id,
        set: {
          userId: state.userId,
          namespace: state.namespace,
          mode: state.mode,
          status: state.status,
          stateJson: JSON.stringify(state),
          lastActive: lastActiveMs,
          expiresAt,
        },
      })
      .run()
  }

  async delete(id: SessionId): Promise<void> {
    this.db.delete(sessions).where(eq(sessions.id, id)).run()
  }

  async list(namespace?: Namespace): Promise<SessionState[]> {
    const now = Date.now()
    const notExpired = or(isNull(sessions.expiresAt), gte(sessions.expiresAt, now))

    const condition = namespace !== undefined
      ? and(eq(sessions.namespace, namespace), notExpired)
      : notExpired

    const rows = this.db.select().from(sessions).where(condition).all()
    return rows.map(row => parseState(row.stateJson))
  }

  async listByUser(userId: string, options?: PaginationOptions): Promise<SessionState[]> {
    const now = Date.now()
    const limit = options?.limit ?? 100
    const offset = options?.offset ?? 0

    const rows = this.db
      .select()
      .from(sessions)
      .where(and(
        eq(sessions.userId, userId),
        or(isNull(sessions.expiresAt), gte(sessions.expiresAt, now)),
      ))
      .orderBy(asc(sessions.lastActive))
      .limit(limit)
      .offset(offset)
      .all()

    return rows.map(row => parseState(row.stateJson))
  }

  async listExpired(): Promise<SessionState[]> {
    const now = Date.now()
    const rows = this.db
      .select()
      .from(sessions)
      .where(and(isNotNull(sessions.expiresAt), lt(sessions.expiresAt, now)))
      .all()

    return rows.map(row => parseState(row.stateJson))
  }

  async countByNamespace(): Promise<Record<string, number>> {
    const rows = this.db
      .select({ namespace: sessions.namespace, count: sql<number>`count(*)`.as('count') })
      .from(sessions)
      .groupBy(sessions.namespace)
      .all()

    const result: Record<string, number> = {}
    for (const row of rows) {
      result[row.namespace] = Number(row.count)
    }
    return result
  }

  async deleteExpired(): Promise<number> {
    const now = Date.now()
    const expired = this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(isNotNull(sessions.expiresAt), lt(sessions.expiresAt, now)))
      .all()

    if (expired.length === 0) return 0

    this.db
      .delete(sessions)
      .where(and(isNotNull(sessions.expiresAt), lt(sessions.expiresAt, now)))
      .run()

    return expired.length
  }

  start(ttlSeconds: number, cleanupIntervalSeconds: number): void {
    this.ttlMs = ttlSeconds * 1000
    if (this.ttlMs === 0) return

    this.cleanupTimer = setInterval(
      () => { void this.deleteExpired() },
      cleanupIntervalSeconds * 1000,
    )
    this.cleanupTimer.unref()
  }

  stop(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }
}
