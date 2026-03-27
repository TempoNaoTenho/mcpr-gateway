import { DownstreamHealth, AuditEventType } from '../types/enums.js'
import type { IHealthMonitor, IAuditLogger } from '../types/interfaces.js'
import type { DownstreamServer, HealthState } from '../types/server.js'
import { postJsonRpc } from '../registry/transport/http.js'
import { isDownstreamAuthError } from '../registry/auth/index.js'

const HEALTH_CHECK_TIMEOUT_MS = 3_000

type InternalHealthState = {
  serverId: string
  status: DownstreamHealth
  lastCheckedAt: Date
  lastHealthyAt: Date | undefined
  lastFailureAt: Date | undefined
  consecutiveFailures: number
  latencyMs: number | undefined
  error: string | undefined
}

type CircuitBreakerConfig = {
  degradedAfterFailures: number
  offlineAfterFailures: number
  resetAfterSeconds: number
}

export class HealthMonitor implements IHealthMonitor {
  private states: Map<string, InternalHealthState> = new Map()
  private servers: Map<string, DownstreamServer> = new Map()
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map()
  private config: CircuitBreakerConfig = {
    degradedAfterFailures: 3,
    offlineAfterFailures: 5,
    resetAfterSeconds: 60,
  }

  constructor(private readonly auditLogger?: IAuditLogger) {}

  start(servers: DownstreamServer[], config: CircuitBreakerConfig): void {
    this.config = config
    this.stop()
    const initialChecks: Promise<HealthState>[] = []

    for (const server of servers) {
      if (!server.enabled || !server.healthcheck?.enabled) continue

      this.servers.set(server.id, server)
      this.states.set(server.id, {
        serverId: server.id,
        status: DownstreamHealth.Unknown,
        lastCheckedAt: new Date(),
        lastHealthyAt: undefined,
        lastFailureAt: undefined,
        consecutiveFailures: 0,
        latencyMs: undefined,
        error: undefined,
      })

      const intervalMs = server.healthcheck.intervalSeconds * 1000
      const timer = setInterval(() => {
        this.check(server.id).catch(() => {
          // errors are captured in state
        })
      }, intervalMs)
      this.timers.set(server.id, timer)
      initialChecks.push(this.check(server.id))
    }

    if (initialChecks.length > 0) {
      void Promise.allSettled(initialChecks)
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
    this.servers.clear()
    this.states.clear()
  }

  getState(serverId: string): HealthState | undefined {
    const internal = this.states.get(serverId)
    if (!internal) return undefined
    return this.toHealthState(internal)
  }

  getAllStates(): Record<string, DownstreamHealth> {
    const result: Record<string, DownstreamHealth> = {}
    for (const [id, state] of this.states.entries()) {
      result[id] = state.status
    }
    return result
  }

  async check(serverId: string): Promise<HealthState> {
    const server = this.servers.get(serverId)
    if (!server) {
      throw new Error(`[health] Unknown server: ${serverId}`)
    }

    if (server.transport === 'stdio') {
      const state: InternalHealthState = {
        serverId,
        status: DownstreamHealth.Healthy,
        lastCheckedAt: new Date(),
        lastHealthyAt: new Date(),
        lastFailureAt: undefined,
        consecutiveFailures: 0,
        latencyMs: 0,
        error: undefined,
      }
      this.states.set(serverId, state)
      return this.toHealthState(state)
    }

    const startMs = Date.now()
    let internal: InternalHealthState = this.states.get(serverId) ?? {
      serverId,
      status: DownstreamHealth.Unknown,
      lastCheckedAt: new Date(),
      lastHealthyAt: undefined,
      lastFailureAt: undefined,
      consecutiveFailures: 0,
      latencyMs: undefined,
      error: undefined,
    }

    try {
      await postJsonRpc(
        server,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'mcpr-gateway-health', version: '1.0.0' },
          },
        },
        undefined,
        HEALTH_CHECK_TIMEOUT_MS,
      )

      const latencyMs = Date.now() - startMs
      const now = new Date()
      const resetAfterMs = this.config.resetAfterSeconds * 1000
      const shouldKeepUnhealthy =
        (internal.status === DownstreamHealth.Offline ||
          internal.status === DownstreamHealth.Degraded) &&
        internal.lastFailureAt !== undefined &&
        now.getTime() - internal.lastFailureAt.getTime() < resetAfterMs

      internal = {
        ...internal,
        status: shouldKeepUnhealthy ? internal.status : DownstreamHealth.Healthy,
        lastCheckedAt: now,
        lastHealthyAt: now,
        lastFailureAt: shouldKeepUnhealthy ? internal.lastFailureAt : undefined,
        consecutiveFailures: shouldKeepUnhealthy ? internal.consecutiveFailures : 0,
        latencyMs,
        error: undefined,
      }
    } catch (err) {
      const latencyMs = Date.now() - startMs
      const errMsg = err instanceof Error ? err.message : String(err)

      if (isDownstreamAuthError(err)) {
        internal = {
          ...internal,
          status: DownstreamHealth.Healthy,
          lastCheckedAt: new Date(),
          lastHealthyAt: new Date(),
          latencyMs,
          error: undefined,
        }
        this.states.set(serverId, internal)
        return this.toHealthState(internal)
      }

      const failures = internal.consecutiveFailures + 1

      let newStatus: DownstreamHealth
      if (failures >= this.config.offlineAfterFailures) {
        newStatus = DownstreamHealth.Offline
      } else if (failures >= this.config.degradedAfterFailures) {
        newStatus = DownstreamHealth.Degraded
      } else {
        newStatus =
          internal.status === DownstreamHealth.Unknown
            ? DownstreamHealth.Unknown
            : internal.status
      }

      internal = {
        ...internal,
        status: newStatus,
        lastCheckedAt: new Date(),
        lastFailureAt: new Date(),
        consecutiveFailures: failures,
        latencyMs,
        error: errMsg,
      }
    }

    const previousStatus = this.states.get(serverId)?.status
    this.states.set(serverId, internal)

    if (
      this.auditLogger &&
      internal.status !== previousStatus &&
      (internal.status === DownstreamHealth.Degraded || internal.status === DownstreamHealth.Offline)
    ) {
      this.auditLogger.emit({
        type: AuditEventType.DownstreamMarkedUnhealthy,
        serverId,
        health: internal.status,
        timestamp: new Date().toISOString(),
      })
    }

    return this.toHealthState(internal)
  }

  async *watchAll(): AsyncIterable<HealthState> {
    for (const state of this.states.values()) {
      yield this.toHealthState(state)
    }
  }

  private toHealthState(internal: InternalHealthState): HealthState {
    return {
      serverId: internal.serverId,
      status: internal.status,
      lastChecked: internal.lastCheckedAt.toISOString(),
      latencyMs: internal.latencyMs,
      error: internal.error,
    }
  }
}
