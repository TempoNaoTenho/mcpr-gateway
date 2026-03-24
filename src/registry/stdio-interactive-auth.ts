import { StdioInteractiveAuthStatus } from '../types/enums.js'
import {
  supportsStdioInteractiveAuth,
  type DownstreamServer,
  type StdioInteractiveAuthState,
} from '../types/server.js'
import type { ToolSchema } from '../types/tools.js'
import { startToolsListStdioSession, type StdioToolsListSessionHandle } from './transport/stdio.js'

const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000

type SessionRecord = {
  server: DownstreamServer
  state: StdioInteractiveAuthState
  handle?: StdioToolsListSessionHandle
  active: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

function idleState(serverId: string): StdioInteractiveAuthState {
  return {
    serverId,
    status: StdioInteractiveAuthStatus.Idle,
    lastUpdatedAt: nowIso(),
  }
}

function isActiveStatus(status: StdioInteractiveAuthStatus): boolean {
  return status === StdioInteractiveAuthStatus.Starting || status === StdioInteractiveAuthStatus.Pending
}

export class StdioInteractiveAuthManager {
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(
    private readonly options: {
      applyTools: (server: DownstreamServer, tools: ToolSchema[]) => Promise<void> | void
      ttlMs?: number
    },
  ) {}

  getState(serverId: string): StdioInteractiveAuthState {
    return this.sessions.get(serverId)?.state ?? idleState(serverId)
  }

  isActive(serverId: string): boolean {
    return isActiveStatus(this.getState(serverId).status)
  }

  syncServers(servers: DownstreamServer[]): void {
    const allowed = new Set(
      servers
        .filter((server) => supportsStdioInteractiveAuth(server) && server.enabled)
        .map((server) => server.id),
    )

    for (const [serverId] of this.sessions) {
      if (!allowed.has(serverId)) {
        this.cancel(serverId, false)
        this.sessions.delete(serverId)
      }
    }
  }

  cancel(serverId: string, keepState = true): StdioInteractiveAuthState {
    const current = this.sessions.get(serverId)
    if (!current) return idleState(serverId)

    current.active = false
    current.state = {
      ...current.state,
      status: StdioInteractiveAuthStatus.Cancelled,
      message: 'Interactive authentication cancelled.',
      lastUpdatedAt: nowIso(),
    }
    current.handle?.cancel()
    if (!keepState) {
      this.sessions.delete(serverId)
      return idleState(serverId)
    }
    return current.state
  }

  async start(server: DownstreamServer): Promise<StdioInteractiveAuthState> {
    if (!supportsStdioInteractiveAuth(server)) {
      throw new Error(`Interactive stdio auth is not enabled for this server`)
    }

    const current = this.sessions.get(server.id)
    if (current && isActiveStatus(current.state.status)) {
      return current.state
    }

    const record: SessionRecord = {
      server,
      active: true,
      state: {
        serverId: server.id,
        status: StdioInteractiveAuthStatus.Starting,
        message: 'Starting stdio process and waiting for authentication signals.',
        lastUpdatedAt: nowIso(),
      },
    }
    this.sessions.set(server.id, record)

    const handle = startToolsListStdioSession(server, {
      timeoutMs: this.options.ttlMs ?? DEFAULT_SESSION_TTL_MS,
      onUpdate: (update) => {
        const previous = this.sessions.get(server.id)
        if (!previous || !previous.active) return
        previous.state = {
          serverId: server.id,
          status: update.interactiveDetected
            ? StdioInteractiveAuthStatus.Pending
            : StdioInteractiveAuthStatus.Starting,
          message: update.message ?? previous.state.message,
          url: update.interactiveUrl,
          lastUpdatedAt: nowIso(),
        }
      },
    })
    record.handle = handle

    void handle.completion
      .then(async (tools) => {
        const latest = this.sessions.get(server.id)
        if (!latest || !latest.active) return
        await this.options.applyTools(server, tools)
        latest.active = false
        latest.state = {
          serverId: server.id,
          status: StdioInteractiveAuthStatus.Ready,
          message:
            latest.state.status === StdioInteractiveAuthStatus.Pending
              ? 'Interactive authentication completed. Tools are ready.'
              : 'Stdio server is ready.',
          url: latest.state.url,
          lastUpdatedAt: nowIso(),
        }
      })
      .catch((error) => {
        const latest = this.sessions.get(server.id)
        if (!latest) return
        if (latest.state.status === StdioInteractiveAuthStatus.Cancelled) return

        latest.active = false
        const errorMessage = error instanceof Error ? error.message : String(error)
        const pending = latest.state.status === StdioInteractiveAuthStatus.Pending
        latest.state = {
          serverId: server.id,
          status:
            error instanceof Error && error.name === 'AbortError' && pending
              ? StdioInteractiveAuthStatus.Expired
              : StdioInteractiveAuthStatus.Failed,
          message:
            error instanceof Error && error.name === 'AbortError' && pending
              ? 'Interactive authentication timed out before completion.'
              : errorMessage,
          url: latest.state.url,
          lastUpdatedAt: nowIso(),
        }
      })

    return record.state
  }
}
