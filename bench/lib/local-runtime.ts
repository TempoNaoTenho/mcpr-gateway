import { setConfig, type GatewayConfig } from '../../src/config/index.js'
import { buildServer } from '../../src/gateway/server.js'
import { debugRoutes } from '../../src/gateway/routes/debug.js'
import { healthRoutes } from '../../src/gateway/routes/health.js'
import { mcpRoutes } from '../../src/gateway/routes/mcp.js'
import { HealthMonitor } from '../../src/health/monitor.js'
import { DownstreamRegistry } from '../../src/registry/registry.js'
import { MemorySessionStore } from '../../src/session/index.js'
import { SelectorEngine } from '../../src/selector/engine.js'
import { TriggerEngine } from '../../src/trigger/index.js'
import { NoopAuditLogger } from './support.js'

export async function createEffectiveBenchmarkRuntime(config: GatewayConfig) {
  setConfig(config)
  const store = new MemorySessionStore()
  const registry = new DownstreamRegistry()
  const auditLogger = new NoopAuditLogger()
  const healthMonitor = new HealthMonitor(auditLogger)
  registry.setHealthMonitor(healthMonitor)
  const selector = new SelectorEngine(healthMonitor)
  const triggerEngine = new TriggerEngine(store, registry, selector, auditLogger)
  const app = buildServer({ logLevel: 'silent' })

  app.register(healthRoutes, { registry })
  app.register(mcpRoutes, {
    store,
    registry,
    triggerEngine,
    healthMonitor,
    getResponseTimeoutMs: () => config.resilience.timeouts.responseMs,
    auditLogger,
  })
  if (config.debug.enabled) {
    app.register(debugRoutes, { store, registry })
  }
  await app.ready()

  store.start(config.session.ttlSeconds, config.session.cleanupIntervalSeconds)
  await registry.start(config.servers, config.resilience)

  return {
    app,
    store,
    registry,
    async close() {
      registry.stop()
      store.stop()
      await app.close()
    },
  }
}
