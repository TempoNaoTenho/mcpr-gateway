import type { FastifyInstance } from 'fastify'
import type { DownstreamRegistry } from '../../registry/registry.js'

interface HealthRoutesOptions {
  registry?: DownstreamRegistry
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.0.0.1')
}

export async function healthRoutes(
  app: FastifyInstance,
  opts: HealthRoutesOptions = {},
): Promise<void> {
  app.get('/health', async () => {
    return { status: 'ok' }
  })

  app.get('/healthz', async () => {
    return { status: 'ok' }
  })

  app.get('/readyz', async () => {
    return { status: 'ok' }
  })

  app.post('/registry/refresh', async (request, reply) => {
    const reg = opts.registry
    if (!reg) return { refreshed: false, error: 'registry not available' }
    if (!isLoopbackAddress(request.ip)) {
      return reply.status(403).send({
        refreshed: false,
        error: 'registry refresh is only available from loopback addresses',
      })
    }

    await reg.refreshAll()

    const servers = await reg.listServers()
    const enabledServers = servers.filter((s) => s.enabled)
    let toolCount = 0
    for (const s of enabledServers) {
      const tools = await reg.getTools(s.id)
      toolCount += tools.length
    }

    return { refreshed: true, serverCount: enabledServers.length, toolCount }
  })
}
