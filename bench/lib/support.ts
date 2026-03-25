import type { AuditEvent, IAuditLogger } from '../../src/types/interfaces.js'

export class NoopAuditLogger implements IAuditLogger {
  emit(_event: AuditEvent): void {}
}
