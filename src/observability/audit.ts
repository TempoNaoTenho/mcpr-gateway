import type { FastifyBaseLogger } from 'fastify'
import type { IAuditLogger, AuditEvent } from '../types/interfaces.js'

export class PinoAuditLogger implements IAuditLogger {
  constructor(private readonly logger: FastifyBaseLogger) {}

  emit(event: AuditEvent): void {
    this.logger.info({ audit: event }, '[audit]')
  }
}
