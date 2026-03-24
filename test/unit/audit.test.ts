import { describe, expect, it, vi } from 'vitest'
import { PinoAuditLogger } from '../../src/observability/audit.js'
import { AuditEventType, OutcomeClass, DownstreamHealth, RefreshTriggerType } from '../../src/types/enums.js'
import type { AuditEvent } from '../../src/types/interfaces.js'

function makeLogger() {
  const info = vi.fn()
  return {
    logger: { info } as never,
    info,
  }
}

describe('PinoAuditLogger', () => {
  it('emits session_created event with audit field', () => {
    const { logger, info } = makeLogger()
    const audit = new PinoAuditLogger(logger)

    const event: AuditEvent = {
      type: AuditEventType.SessionCreated,
      sessionId: 'sess-1',
      userId: 'user-1',
      namespace: 'gmail',
      timestamp: new Date().toISOString(),
    }

    audit.emit(event)

    expect(info).toHaveBeenCalledOnce()
    const [fields, msg] = info.mock.calls[0]!
    expect(msg).toBe('[audit]')
    expect(fields.audit.type).toBe(AuditEventType.SessionCreated)
    expect(fields.audit.sessionId).toBe('sess-1')
    expect(fields.audit.userId).toBe('user-1')
    expect(fields.audit.namespace).toBe('gmail')
  })

  it('emits tool_executed event', () => {
    const { logger, info } = makeLogger()
    const audit = new PinoAuditLogger(logger)

    const event: AuditEvent = {
      type: AuditEventType.ToolExecuted,
      sessionId: 'sess-2',
      userId: 'user-2',
      toolName: 'send_email',
      downstreamServer: 'gmail-server',
      outcome: OutcomeClass.Success,
      latencyMs: 42,
      timestamp: new Date().toISOString(),
    }

    audit.emit(event)

    const [fields] = info.mock.calls[0]!
    expect(fields.audit.type).toBe(AuditEventType.ToolExecuted)
    expect(fields.audit.outcome).toBe(OutcomeClass.Success)
    expect(fields.audit.latencyMs).toBe(42)
  })

  it('emits execution_denied event', () => {
    const { logger, info } = makeLogger()
    const audit = new PinoAuditLogger(logger)

    const event: AuditEvent = {
      type: AuditEventType.ExecutionDenied,
      sessionId: 'sess-3',
      userId: 'user-3',
      toolName: 'delete_account',
      reason: 'tool not visible in current session window',
      timestamp: new Date().toISOString(),
    }

    audit.emit(event)

    const [fields] = info.mock.calls[0]!
    expect(fields.audit.type).toBe(AuditEventType.ExecutionDenied)
    expect(fields.audit.reason).toContain('not visible')
  })

  it('emits downstream_marked_unhealthy event', () => {
    const { logger, info } = makeLogger()
    const audit = new PinoAuditLogger(logger)

    const event: AuditEvent = {
      type: AuditEventType.DownstreamMarkedUnhealthy,
      serverId: 'my-server',
      health: DownstreamHealth.Offline,
      timestamp: new Date().toISOString(),
    }

    audit.emit(event)

    const [fields] = info.mock.calls[0]!
    expect(fields.audit.type).toBe(AuditEventType.DownstreamMarkedUnhealthy)
    expect(fields.audit.health).toBe(DownstreamHealth.Offline)
  })

  it('emits active_window_recomputed event', () => {
    const { logger, info } = makeLogger()
    const audit = new PinoAuditLogger(logger)

    const event: AuditEvent = {
      type: AuditEventType.ActiveWindowRecomputed,
      sessionId: 'sess-4',
      toolCount: 5,
      triggerUsed: RefreshTriggerType.ErrorThreshold,
      timestamp: new Date().toISOString(),
    }

    audit.emit(event)

    const [fields] = info.mock.calls[0]!
    expect(fields.audit.type).toBe(AuditEventType.ActiveWindowRecomputed)
    expect(fields.audit.toolCount).toBe(5)
  })
})
