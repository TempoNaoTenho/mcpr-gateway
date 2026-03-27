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

/**
 * MCP **client** transport over stdio (stdin/stdout) is DISABLED for now — the gateway runs as HTTP only.
 * Implementation is kept in `./gateway/stdio-mcp.ts` (and unit tests) for a future re-enable: import `runStdioMcp`,
 * set this flag from `process.env['GATEWAY_TRANSPORT'] === 'stdio'`, and restore stderr-only logging for that branch.
 */
const isStdioTransport = false

type SessionBackend = ISessionStore & {
  start(ttlSeconds: number, cleanupIntervalSeconds: number): void
  stop(): void
}

function resolveGatewayDatabasePath(): string {
  if (process.env['DATABASE_PATH']) return process.env['DATABASE_PATH']
  if (process.env['VITEST'] === 'true') {
    const workerId = process.env['VITEST_WORKER_ID'] ?? '0'
    return join(tmpdir(), 'mcpr-gateway-vitest', `worker-${workerId}.db`)
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

function hasNodeOption(flag: string): boolean {
  return process.execArgv.includes(flag) || (process.env['NODE_OPTIONS'] ?? '').includes(flag)
}

function assertSupportedNodeRuntime(): void {
  const nodeVersion = process.versions.node
  const nodeMajor = Number(nodeVersion.split('.')[0] ?? '0')
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22 || nodeMajor >= 25 || nodeMajor % 2 === 1) {
    throw new Error(
      `Unsupported Node.js runtime ${nodeVersion}. Use Node 22 or 24 LTS with isolated-vm.`
    )
  }
  if (!hasNodeOption('--no-node-snapshot')) {
    throw new Error(
      'isolated-vm requires --no-node-snapshot on Node 20+. Restart with NODE_OPTIONS=--no-node-snapshot or use npm run dev:gateway.'
    )
  }
}

if (!isStdioTransport) {
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertSupportedNodeRuntime()
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

  activeStore.start(config.session.ttlSeconds, config.session.cleanupIntervalSeconds)

  async function shutdownHttp(): Promise<void> {
    registry.stop()
    activeStore.stop()
    if (!memoryBackend) sqliteAdapter.disconnect()
    if (!isStdioTransport) {
      await app.close()
    }
  }

  process.on('SIGTERM', async () => {
    await shutdownHttp()
    process.exit(0)
  })
  process.on('SIGINT', async () => {
    await shutdownHttp()
    process.exit(0)
  })

  function formatUnhandledReason(reason: unknown): string {
    if (reason instanceof Error) {
      return reason.stack ?? reason.message
    }
    try {
      return JSON.stringify(reason)
    } catch {
      return String(reason)
    }
  }

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err)
    if (err instanceof Error && err.stack) {
      console.error(err.stack)
    }
    process.exit(1)
  })
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise)
    console.error('Reason:', formatUnhandledReason(reason))
    if (
      process.env['GATEWAY_RELAX_UNHANDLED_REJECTION'] === '1' &&
      process.env['NODE_ENV'] !== 'production'
    ) {
      console.error(
        'GATEWAY_RELAX_UNHANDLED_REJECTION=1 (non-production): process continues; state may be corrupt. Do not use in production.'
      )
      return
    }
    process.exit(1)
  })

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

  const port = Number(process.env['PORT'] ?? 3000)
  const host = process.env['HOST'] ?? '127.0.0.1'
  /** When HOST=127.0.0.1, clients using http://localhost often hit ::1 (IPv6) and get connection errors;
   * binding :: with ipv6Only=false accepts IPv4-mapped and IPv6 on typical Linux/macOS dual-stack sockets.
   * May listen on all interfaces — use a firewall outside trusted dev networks. */
  const dualStack = process.env['GATEWAY_DUAL_STACK'] === '1'
  const listenOpts = dualStack
    ? { port, host: '::' as const, ipv6Only: false as const }
    : { port, host }

  if (dualStack) {
    app.log.warn(
      '[gateway] GATEWAY_DUAL_STACK=1: listening on :: (dual-stack). Ensure client URL matches your setup (e.g. http://127.0.0.1:PORT or http://localhost:PORT). Do not expose on untrusted LANs without a firewall.',
    )
  }

  app.listen(listenOpts, (err) => {
    if (err) {
      app.log.error(err)
      process.exit(1)
    }
  })
}
