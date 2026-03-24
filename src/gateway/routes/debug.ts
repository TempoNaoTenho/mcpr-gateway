import type { FastifyInstance } from 'fastify'
import type { ISessionStore } from '../../types/interfaces.js'
import type { DownstreamRegistry } from '../../registry/registry.js'

interface DebugRoutesOptions {
  store: ISessionStore
  registry: DownstreamRegistry
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.0.0.1')
}

export async function debugRoutes(app: FastifyInstance, opts: DebugRoutesOptions): Promise<void> {
  const { store, registry } = opts

  app.get<{ Params: { id: string } }>('/debug/session/:id', async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) {
      return reply.status(403).send({ error: 'debug endpoints are only available from loopback addresses' })
    }
    const session = await store.get(request.params.id as never)
    if (!session) {
      return reply.status(404).send({ error: 'session not found' })
    }
    return session
  })

  app.get<{ Params: { id: string } }>('/debug/selector/:id', async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) {
      return reply.status(403).send({ error: 'debug endpoints are only available from loopback addresses' })
    }
    const session = await store.get(request.params.id as never)
    if (!session) {
      return reply.status(404).send({ error: 'session not found' })
    }
    const trace = session.lastSelectorDecision?.trace ?? null
    return { trace }
  })

  app.get('/debug/registry', async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) {
      return reply.status(403).send({ error: 'debug endpoints are only available from loopback addresses' })
    }
    const servers = await registry.listServers()
    const result = await Promise.all(
      servers.map(async (server) => {
        const tools = await registry.getTools(server.id)
        return { server, toolCount: tools.length }
      }),
    )
    return { servers: result }
  })

  app.get('/debug/health', async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) {
      return reply.status(403).send({ error: 'debug endpoints are only available from loopback addresses' })
    }
    return { health: registry.getHealthStates() }
  })
}
