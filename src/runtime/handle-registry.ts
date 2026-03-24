export type HandleTarget = {
  serverId: string
  name: string
  namespace: string
}

export class HandleRegistry {
  private nextId = 1

  private readonly byHandle = new Map<string, HandleTarget>()

  private readonly byTargetKey = new Map<string, string>()

  private readonly expiresAt = new Map<string, number>()

  private readonly ttlMs: number

  constructor(ttlMs: number = 300_000) {
    this.ttlMs = ttlMs
  }

  register(target: HandleTarget): string {
    this.cleanupExpired()
    const key = this.targetKey(target)
    const existing = this.byTargetKey.get(key)
    if (existing) {
      this.expiresAt.set(existing, Date.now() + this.ttlMs)
      return existing
    }

    const handle = `h_${this.nextId}`
    this.nextId += 1
    this.byHandle.set(handle, target)
    this.byTargetKey.set(key, handle)
    this.expiresAt.set(handle, Date.now() + this.ttlMs)
    return handle
  }

  resolve(handle: string): HandleTarget | undefined {
    this.cleanupExpired()
    const expires = this.expiresAt.get(handle)
    if (expires && Date.now() > expires) {
      this.byHandle.delete(handle)
      this.expiresAt.delete(handle)
      return undefined
    }
    return this.byHandle.get(handle)
  }

  entries(): Array<{ handle: string; target: HandleTarget }> {
    this.cleanupExpired()
    return [...this.byHandle.entries()].map(([handle, target]) => ({ handle, target }))
  }

  private cleanupExpired(): void {
    const now = Date.now()
    for (const [handle, expires] of this.expiresAt.entries()) {
      if (now > expires) {
        const target = this.byHandle.get(handle)
        if (target) {
          this.byTargetKey.delete(this.targetKey(target))
        }
        this.byHandle.delete(handle)
        this.expiresAt.delete(handle)
      }
    }
  }

  private targetKey(target: HandleTarget): string {
    return `${target.serverId}::${target.namespace}::${target.name}`
  }
}
