import type { IAuditLogger, AuditEvent } from '../types/interfaces.js'
import type { IAuditRepository } from '../repositories/audit/interface.js'

export class CompositeAuditLogger implements IAuditLogger {
  constructor(
    private readonly pino: IAuditLogger,
    private readonly repo: IAuditRepository,
  ) {}

  emit(event: AuditEvent): void {
    this.pino.emit(event)
    this.repo.append(event).catch(err => {
      console.error('[audit] Failed to persist audit event:', err)
    })
  }
}
