type WindowEntry = {
  timestamps: number[]
}

export type RateLimitConfig = {
  perSession: { maxRequests: number; windowSeconds: number }
  perUser: { maxRequests: number; windowSeconds: number }
  perDownstreamConcurrency: number
}

export class RateLimiter {
  private sessionWindows: Map<string, WindowEntry> = new Map()
  private userWindows: Map<string, WindowEntry> = new Map()
  private downstreamConcurrency: Map<string, number> = new Map()

  constructor(private config: RateLimitConfig) {}

  updateConfig(config: RateLimitConfig): void {
    this.config = config
    this.sessionWindows.clear()
    this.userWindows.clear()
    this.downstreamConcurrency.clear()
  }

  checkSession(sessionId: string): boolean {
    return this.checkWindow(this.sessionWindows, sessionId, this.config.perSession)
  }

  checkUser(userId: string): boolean {
    return this.checkWindow(this.userWindows, userId, this.config.perUser)
  }

  acquireDownstream(serverId: string): (() => void) | null {
    const current = this.downstreamConcurrency.get(serverId) ?? 0
    if (current >= this.config.perDownstreamConcurrency) {
      return null
    }
    this.downstreamConcurrency.set(serverId, current + 1)
    let released = false
    return () => {
      if (!released) {
        released = true
        const count = this.downstreamConcurrency.get(serverId) ?? 1
        this.downstreamConcurrency.set(serverId, Math.max(0, count - 1))
      }
    }
  }

  private checkWindow(
    map: Map<string, WindowEntry>,
    key: string,
    config: { maxRequests: number; windowSeconds: number },
  ): boolean {
    const now = Date.now()
    const windowMs = config.windowSeconds * 1000
    const cutoff = now - windowMs

    const entry = map.get(key) ?? { timestamps: [] }
    const filtered = entry.timestamps.filter((t) => t > cutoff)

    if (filtered.length >= config.maxRequests) {
      map.set(key, { timestamps: filtered })
      return false
    }

    filtered.push(now)
    map.set(key, { timestamps: filtered })
    return true
  }
}
