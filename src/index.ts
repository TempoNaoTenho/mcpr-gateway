export * from './types/index.js'
export * from './config/index.js'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initConfig, getConfig } from './config/index.js'
import { RuntimeConfigManager } from './config/runtime.js'
import { buildServer } from './gateway/server.js'
import { healthRoutes } from './gateway/routes/health.js'
import { mcpRoutes } from './gateway/routes/mcp.js'
import { debugRoutes } from './gateway/routes/debug.js'
import { adminRoutes } from './gateway/routes/admin.js'
import { uiRoutes } from './gateway/routes/ui.js'
import { sessionStore } from './session/index.js'
import { registry } from './registry/index.js'
import { SelectorEngine } from './selector/engine.js'
import { TriggerEngine } from './trigger/index.js'
import { HealthMonitor } from './health/monitor.js'
import { RateLimiter } from './resilience/rateLimiter.js'
import { PinoAuditLogger } from './observability/audit.js'
import { CompositeAuditLogger } from './observability/composite-audit.js'
import { sqliteAdapter } from './db/index.js'
import { SqliteSessionRepository } from './repositories/sessions/sqlite.js'
import { SqliteAuditRepository } from './repositories/audit/sqlite.js'
import { SqliteConfigRepository } from './repositories/config/sqlite.js'
import { SqliteDownstreamAuthRepository } from './repositories/downstreamAuth/sqlite.js'
import type { IAuditLogger, ISessionStore } from './types/interfaces.js'
import type { IAuditRepository } from './repositories/audit/interface.js'
import type { IConfigRepository } from './repositories/config/interface.js'
import { downstreamAuthManager } from './registry/auth/index.js'

const memoryBackend = process.env['SESSION_BACKEND'] === 'memory'

type SessionBackend = ISessionStore & {
  start(ttlSeconds: number, cleanupIntervalSeconds: number): void
  stop(): void
}

function resolveGatewayDatabasePath(): string {
  if (process.env['DATABASE_PATH']) return process.env['DATABASE_PATH']
  if (process.env['VITEST'] === 'true') {
    const workerId = process.env['VITEST_WORKER_ID'] ?? '0'
    return join(tmpdir(), 'mcp-session-gateway-vitest', `worker-${workerId}.db`)
  }
  return './data/gateway.db'
}

let activeStore: SessionBackend
let auditRepoInstance: IAuditRepository | undefined
let configRepoInstance: IConfigRepository | undefined

if (memoryBackend) {
  activeStore = sessionStore
  downstreamAuthManager.setRepository(undefined)
} else {
  const dbPath = resolveGatewayDatabasePath()
  sqliteAdapter.connect(dbPath)
  const db = sqliteAdapter.getDb()
  activeStore = new SqliteSessionRepository(db)
  auditRepoInstance = new SqliteAuditRepository(db)
  configRepoInstance = new SqliteConfigRepository(db)
  downstreamAuthManager.setRepository(new SqliteDownstreamAuthRepository(db))
}

export const app = buildServer({ logLevel: process.env['LOG_LEVEL'] ?? 'info' })

const pinoAudit = new PinoAuditLogger(app.log)
const auditLogger: IAuditLogger = auditRepoInstance
  ? new CompositeAuditLogger(pinoAudit, auditRepoInstance)
  : pinoAudit

const healthMonitor = new HealthMonitor(auditLogger)
registry.setHealthMonitor(healthMonitor)

const selector = new SelectorEngine(healthMonitor)
const triggerEngine = new TriggerEngine(activeStore, registry, selector, auditLogger)

let rateLimiter: RateLimiter | undefined
let runtimeConfigManager: RuntimeConfigManager | undefined

app.register(healthRoutes, { registry })
app.register(mcpRoutes, {
  store: activeStore,
  registry,
  triggerEngine,
  healthMonitor,
  getRateLimiter: () => rateLimiter,
  getResponseTimeoutMs: () => runtimeConfigManager?.getEffective().resilience.timeouts.responseMs,
  auditLogger,
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath = process.env['CONFIG_PATH'] ?? './config'
  initConfig(configPath)
  let config = getConfig()

  rateLimiter = new RateLimiter(config.resilience.rateLimit)
  runtimeConfigManager = new RuntimeConfigManager({
    bootstrap: { auth: config.auth },
    initial: config,
    registry,
    rateLimiter,
    configRepo: memoryBackend ? undefined : configRepoInstance,
    configPath,
  })
  await runtimeConfigManager.initialize()
  config = runtimeConfigManager.getEffective()

  if (config.debug.enabled) {
    app.register(debugRoutes, { store: activeStore, registry })
  }

  const enableAdminRoutes =
    config.debug.enabled ||
    Boolean(process.env['ADMIN_TOKEN']) ||
    process.env['NODE_ENV'] !== 'production'
  if (enableAdminRoutes) {
    app.register(adminRoutes, {
      auditRepo: memoryBackend ? undefined : auditRepoInstance,
      configRepo: memoryBackend ? undefined : configRepoInstance,
      configManager: runtimeConfigManager,
      sessionStore: activeStore,
      registry,
    })
  }

  app.register(uiRoutes)

  activeStore.start(config.session.ttlSeconds, config.session.cleanupIntervalSeconds)

  process.on('SIGTERM', async () => {
    registry.stop()
    activeStore.stop()
    if (!memoryBackend) sqliteAdapter.disconnect()
    await app.close()
    process.exit(0)
  })
  process.on('SIGINT', async () => {
    registry.stop()
    activeStore.stop()
    if (!memoryBackend) sqliteAdapter.disconnect()
    await app.close()
    process.exit(0)
  })

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason)
    process.exit(1)
  })

  const port = Number(process.env['PORT'] ?? 3000)
  const host = process.env['HOST'] ?? '127.0.0.1'

  app.listen({ port, host }, (err) => {
    if (err) {
      app.log.error(err)
      process.exit(1)
    }
  })
}
