import type { SessionId, Namespace } from '../types/identity.js'
import type { SessionState } from '../types/session.js'
import type { ISessionStore } from '../types/interfaces.js'

/** In-process session store for `SESSION_BACKEND=memory` (no SQLite / no cross-restart persistence). */
class MemorySessionStore implements ISessionStore {
  private store = new Map<string, SessionState>()
  private cleanupTimer: NodeJS.Timeout | null = null
  private ttlMs = 0

  async get(id: SessionId): Promise<SessionState | undefined> {
    const session = this.store.get(id)
    if (!session) return undefined

    if (this.ttlMs > 0 && this.isExpired(session)) {
      this.store.delete(id)
      return undefined
    }

    return session
  }

  async set(id: SessionId, state: SessionState): Promise<void> {
    this.store.set(id, state)
  }

  async delete(id: SessionId): Promise<void> {
    this.store.delete(id)
  }

  async list(namespace?: Namespace): Promise<SessionState[]> {
    const all = Array.from(this.store.values())
    if (namespace === undefined) return all
    return all.filter((s) => s.namespace === namespace)
  }

  start(ttlSeconds: number, cleanupIntervalSeconds: number): void {
    this.ttlMs = ttlSeconds * 1000

    if (this.ttlMs === 0) return

    this.cleanupTimer = setInterval(
      () => this.runCleanup(),
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

  private isExpired(session: SessionState): boolean {
    const lastActive = new Date(session.lastActiveAt).getTime()
    return lastActive + this.ttlMs < Date.now()
  }

  private runCleanup(): void {
    for (const [id, session] of this.store) {
      if (this.isExpired(session)) {
        this.store.delete(id)
      }
    }
  }
}

export const sessionStore = new MemorySessionStore()
export { MemorySessionStore }
