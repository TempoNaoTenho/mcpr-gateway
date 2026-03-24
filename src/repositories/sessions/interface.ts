import type { ISessionStore } from '../../types/interfaces.js'
import type { SessionState } from '../../types/session.js'

export interface PaginationOptions {
  limit?: number
  offset?: number
}

export interface ISessionRepository extends ISessionStore {
  listByUser(userId: string, options?: PaginationOptions): Promise<SessionState[]>
  listExpired(): Promise<SessionState[]>
  countByNamespace(): Promise<Record<string, number>>
  deleteExpired(): Promise<number>
}
