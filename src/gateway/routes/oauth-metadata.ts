import type { FastifyInstance } from 'fastify'
import { getConfig } from '../../config/index.js'
import { NamespaceSchema } from '../../types/identity.js'
import { getInboundOAuth } from '../../auth/oauth-config.js'
import { setMcpCorsHeaders } from '../cors.js'

function protectedResourceBody(namespace: string) {
  const oauth = getInboundOAuth(getConfig().auth)
  if (!oauth) {
    return null
  }
  if (!getConfig().namespaces[namespace]) {
    return null
  }
  const resource = `${oauth.publicBaseUrl.replace(/\/$/, '')}/mcp/${namespace}`
  const authorization_servers = oauth.authorizationServers.map((s) => s.issuer.replace(/\/$/, ''))
  return {
    resource,
    authorization_servers,
    scopes_supported: oauth.scopesSupported?.length ? oauth.scopesSupported : ['openid'],
    bearer_methods_supported: ['header'],
  }
}

export async function oauthMetadataRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { namespace: string } }>(
    '/.well-known/oauth-protected-resource/mcp/:namespace',
    async (request, reply) => {
      const allowedOrigins = getInboundOAuth(getConfig().auth)?.allowedBrowserOrigins
      setMcpCorsHeaders(reply, request.headers.origin, allowedOrigins)
      const nsResult = NamespaceSchema.safeParse(request.params.namespace)
      if (!nsResult.success) {
        return reply.status(400).send({ error: 'invalid_namespace' })
      }
      const body = protectedResourceBody(nsResult.data)
      if (!body) {
        return reply.status(404).send({ error: 'not_found' })
      }
      return reply.header('Content-Type', 'application/json; charset=utf-8').send(body)
    },
  )

  app.get<{ Params: { namespace: string } }>(
    '/mcp/:namespace/.well-known/oauth-protected-resource',
    async (request, reply) => {
      const allowedOrigins = getInboundOAuth(getConfig().auth)?.allowedBrowserOrigins
      setMcpCorsHeaders(reply, request.headers.origin, allowedOrigins)
      const nsResult = NamespaceSchema.safeParse(request.params.namespace)
      if (!nsResult.success) {
        return reply.status(400).send({ error: 'invalid_namespace' })
      }
      const body = protectedResourceBody(nsResult.data)
      if (!body) {
        return reply.status(404).send({ error: 'not_found' })
      }
      return reply.header('Content-Type', 'application/json; charset=utf-8').send(body)
    },
  )
}
