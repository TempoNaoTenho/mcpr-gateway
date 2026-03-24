import type { SessionId, Namespace } from './identity.js'
import type { SessionState } from './session.js'
import type { DownstreamServer, HealthState } from './server.js'
import type { ToolRecord, Toolcard, VisibleTool } from './tools.js'
import type { SelectorInput, SelectorDecision } from './selector.js'
import type { ExecutionOutcome } from './execution.js'
import type { OutcomeClass, DownstreamHealth, AuditEventType, RefreshTriggerType } from './enums.js'

export interface ISessionStore {
  get(id: SessionId): Promise<SessionState | undefined>
  set(id: SessionId, state: SessionState): Promise<void>
  delete(id: SessionId): Promise<void>
  list(namespace?: Namespace): Promise<SessionState[]>
}

export interface IRegistryAdapter {
  listServers(): Promise<DownstreamServer[]>
  getServer(id: string): Promise<DownstreamServer | undefined>
  getTools(serverId: string): Promise<ToolRecord[]>
  getToolsByNamespace?(namespace: string): { server: DownstreamServer; records: ToolRecord[] }[]
  refreshTools(serverId: string): Promise<ToolRecord[]>
}

export interface IHealthMonitor {
  start(servers: DownstreamServer[], config: { degradedAfterFailures: number; offlineAfterFailures: number; resetAfterSeconds: number }): void
  stop(): void
  check(serverId: string): Promise<HealthState>
  getState(serverId: string): HealthState | undefined
  getAllStates(): Record<string, DownstreamHealth>
  watchAll(): AsyncIterable<HealthState>
}

export interface ISelectorEngine {
  select(input: SelectorInput): Promise<SelectorDecision>
  rerank(tools: Toolcard[], query: string): Promise<Toolcard[]>
}

export interface IExecutionRouter {
  route(toolName: string, args: unknown, sessionId: SessionId): Promise<ExecutionOutcome>
  resolveServer(toolName: string, sessionId: SessionId): Promise<DownstreamServer | undefined>
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export type AuditEvent =
  | { type: AuditEventType.SessionCreated; sessionId: string; userId: string; namespace: string; timestamp: string }
  | { type: AuditEventType.BootstrapWindowPublished; sessionId: string; toolCount: number; triggerUsed: RefreshTriggerType; timestamp: string }
  | { type: AuditEventType.ActiveWindowRecomputed; sessionId: string; toolCount: number; triggerUsed: RefreshTriggerType; timestamp: string }
  | { type: AuditEventType.ToolExecuted; sessionId: string; userId: string; toolName: string; downstreamServer: string; outcome: OutcomeClass; latencyMs: number; timestamp: string }
  | { type: AuditEventType.ExecutionDenied; sessionId: string; userId: string; toolName: string; reason: string; timestamp: string }
  | { type: AuditEventType.DownstreamMarkedUnhealthy; serverId: string; health: DownstreamHealth; timestamp: string }

export interface IAuditLogger {
  emit(event: AuditEvent): void
}

export interface IVisibleToolProvider {
  getVisibleTools(sessionId: SessionId): Promise<VisibleTool[]>
}
