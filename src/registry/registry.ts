import type { IRegistryAdapter, IHealthMonitor } from '../types/interfaces.js'
import { supportsStdioInteractiveAuth, type DownstreamServer } from '../types/server.js'
import type { HealthState } from '../types/server.js'
import type { ToolRecord, ToolSchema } from '../types/tools.js'
import type { DownstreamHealth } from '../types/enums.js'
import type { ResilienceConfig } from '../config/schemas.js'
import { normalizeToolRecord } from './normalize.js'
import { downstreamAuthManager, isDownstreamAuthError } from './auth/index.js'
import { fetchToolsHttp } from './transport/http.js'
import { fetchToolsStdio } from './transport/stdio.js'
import { StdioInteractiveAuthManager } from './stdio-interactive-auth.js'

function effectiveRefreshIntervalSeconds(server: DownstreamServer): number | undefined {
  if (server.refreshIntervalSeconds != null && server.refreshIntervalSeconds > 0) {
    return server.refreshIntervalSeconds
  }
  if (server.discovery?.mode === 'auto') {
    return 300
  }
  return undefined
}

export class DownstreamRegistry implements IRegistryAdapter {
  private servers: Map<string, DownstreamServer> = new Map()
  private toolCache: Map<string, ToolRecord[]> = new Map()
  private refreshTimers: Map<string, ReturnType<typeof setInterval>> = new Map()
  private healthMonitor: IHealthMonitor | undefined
  private responseTimeoutMs: number | undefined
  private readonly stdioInteractiveAuth = new StdioInteractiveAuthManager({
    applyTools: async (server, tools) => {
      this.cacheRawTools(server, tools)
    },
  })

  setHealthMonitor(monitor: IHealthMonitor): void {
    this.healthMonitor = monitor
  }

  async listServers(): Promise<DownstreamServer[]> {
    return [...this.servers.values()]
  }

  async getServer(id: string): Promise<DownstreamServer | undefined> {
    return this.servers.get(id)
  }

  async getTools(serverId: string): Promise<ToolRecord[]> {
    return this.toolCache.get(serverId) ?? []
  }

  getToolsByNamespace(namespace: string): { server: DownstreamServer; records: ToolRecord[] }[] {
    const result: { server: DownstreamServer; records: ToolRecord[] }[] = []
    for (const server of this.servers.values()) {
      if (!server.enabled || !server.namespaces.includes(namespace)) continue
      const cached = this.toolCache.get(server.id) ?? []
      // Override namespace to match the queried namespace for candidate filters
      const records = cached.map((r) => (r.namespace !== namespace ? { ...r, namespace } : r))
      result.push({ server, records })
    }
    return result
  }

  async refreshTools(serverId: string): Promise<ToolRecord[]> {
    const server = this.servers.get(serverId)
    if (!server) throw new Error(`[registry] Unknown server: ${serverId}`)
    if (
      server.transport === 'stdio' &&
      this.stdioInteractiveAuth.isActive(serverId)
    ) {
      throw new Error(`[registry/stdio] Interactive authentication is already in progress for ${serverId}`)
    }

    let rawTools: ToolSchema[]
    try {
      rawTools =
        server.transport === 'stdio'
          ? await fetchToolsStdio(server)
          : await fetchToolsHttp(server, this.responseTimeoutMs)
    } catch (error) {
      if (isDownstreamAuthError(error)) {
        throw error
      }
      throw error
    }
    const records = this.cacheRawTools(server, rawTools)
    return records
  }

  getStdioInteractiveAuthState(serverId: string) {
    return this.stdioInteractiveAuth.getState(serverId)
  }

  async startStdioInteractiveAuth(serverId: string) {
    const server = this.servers.get(serverId)
    if (!server) throw new Error(`[registry] Unknown server: ${serverId}`)
    if (!supportsStdioInteractiveAuth(server)) {
      throw new Error(`[registry/stdio] Interactive authentication is not enabled for ${serverId}`)
    }
    return this.stdioInteractiveAuth.start(server)
  }

  cancelStdioInteractiveAuth(serverId: string) {
    return this.stdioInteractiveAuth.cancel(serverId)
  }

  async refreshAll(): Promise<void> {
    const enabledServers = [...this.servers.values()].filter((s) => s.enabled)
    await this.refreshMany(enabledServers)
  }

  private async refreshMany(servers: DownstreamServer[]): Promise<void> {
    const results = await Promise.allSettled(
      servers.map((s) => this.refreshTools(s.id)),
    )
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'rejected') {
        const serverId = servers[i].id
        if (isDownstreamAuthError(result.reason)) {
          console.error(`[registry] Failed to refresh server ${serverId}:`, result.reason.message)
        } else {
          console.error(`[registry] Failed to refresh server ${serverId}:`, result.reason)
        }
      }
    }
  }

  getHealthStates(): Record<string, DownstreamHealth> {
    return this.healthMonitor?.getAllStates() ?? {}
  }

  getHealthState(serverId: string): HealthState | undefined {
    return this.healthMonitor?.getState(serverId)
  }

  async checkHealth(serverId: string): Promise<HealthState | undefined> {
    const server = this.servers.get(serverId)
    if (!server) throw new Error(`[registry] Unknown server: ${serverId}`)
    if (!this.healthMonitor || !server.healthcheck?.enabled) {
      return this.getHealthState(serverId)
    }

    return this.healthMonitor.check(serverId)
  }

  async start(servers: DownstreamServer[], resilienceConfig?: ResilienceConfig): Promise<void> {
    this.stop()
    this.servers.clear()
    this.toolCache.clear()
    this.responseTimeoutMs = resilienceConfig?.timeouts.responseMs

    for (const server of servers) {
      this.servers.set(server.id, server)
    }
    downstreamAuthManager.syncServers(servers)
    this.stdioInteractiveAuth.syncServers(servers)

    const autoRefreshableServers = servers.filter((server) => server.enabled)
    await this.refreshMany(autoRefreshableServers)

    if (this.healthMonitor && resilienceConfig) {
      this.healthMonitor.start(servers, resilienceConfig.circuitBreaker)
    }

    for (const server of servers) {
      const intervalSec = effectiveRefreshIntervalSeconds(server)
      if (server.enabled && intervalSec) {
        const intervalMs = intervalSec * 1000
        const timer = setInterval(() => {
          this.refreshTools(server.id).catch((err) => {
            console.error(`[registry] Periodic refresh failed for ${server.id}:`, err)
          })
        }, intervalMs)
        this.refreshTimers.set(server.id, timer)
      }
    }
  }

  stop(): void {
    for (const serverId of this.servers.keys()) {
      this.stdioInteractiveAuth.cancel(serverId, false)
    }
    for (const timer of this.refreshTimers.values()) {
      clearInterval(timer)
    }
    this.refreshTimers.clear()
    this.healthMonitor?.stop()
  }

  private cacheRawTools(server: DownstreamServer, rawTools: ToolSchema[]): ToolRecord[] {
    const records = rawTools.map((raw) => normalizeToolRecord(raw, server))
    this.toolCache.set(server.id, records)
    return records
  }
}
