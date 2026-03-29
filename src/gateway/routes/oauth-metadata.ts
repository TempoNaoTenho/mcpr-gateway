import type { FastifyInstance, FastifyReply } from 'fastify'
import { getConfig } from '../../config/index.js'
import { NamespaceSchema } from '../../types/identity.js'
import { getInboundOAuth, oauthAppliesToNamespace } from '../../auth/oauth-config.js'
import {
  getAuthorizationServerMetadataDocument,
  getOpenIdConfigurationDocument,
} from '../../auth/oauth-issuer-metadata.js'
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

function metadataContext(namespace?: string): {
  oauth: NonNullable<ReturnType<typeof getInboundOAuth>>
  issuer: NonNullable<ReturnType<typeof getInboundOAuth>>['authorizationServers'][number]
} | null {
  const config = getConfig()
  const oauth = getInboundOAuth(config.auth)
  if (!oauth) return null

  if (namespace) {
    const nsKeys = new Set(Object.keys(config.namespaces))
    if (!oauthAppliesToNamespace(oauth, namespace, nsKeys)) {
      return null
    }
  } else if (config.auth.mode === 'hybrid') {
    const required = oauth.requireForNamespaces?.filter((ns) => config.namespaces[ns])
    if (required && required.length === 0) {
      return null
    }
  }

  const issuer = oauth.authorizationServers[0]
  if (!issuer) return null
  return { oauth, issuer }
}

async function sendDiscoveryDocument(
  reply: FastifyReply,
  origin: string | undefined,
  builder: () => Promise<Record<string, unknown> | null>,
) {
  const allowedOrigins = getInboundOAuth(getConfig().auth)?.allowedBrowserOrigins
  setMcpCorsHeaders(reply, origin, allowedOrigins)
  const body = await builder()
  if (!body) {
    return reply.status(404).send({ error: 'not_found' })
  }
  return reply.header('Content-Type', 'application/json; charset=utf-8').send(body)
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
    '/.well-known/oauth-authorization-server/mcp/:namespace',
    async (request, reply) => {
      const nsResult = NamespaceSchema.safeParse(request.params.namespace)
      if (!nsResult.success) {
        return reply.status(400).send({ error: 'invalid_namespace' })
      }
      return sendDiscoveryDocument(reply, request.headers.origin, async () => {
        const ctx = metadataContext(nsResult.data)
        if (!ctx) return null
        return getAuthorizationServerMetadataDocument(ctx.oauth, ctx.issuer, nsResult.data)
      })
    },
  )

  app.get<{ Params: { namespace: string } }>(
    '/mcp/:namespace/.well-known/oauth-authorization-server',
    async (request, reply) => {
      const nsResult = NamespaceSchema.safeParse(request.params.namespace)
      if (!nsResult.success) {
        return reply.status(400).send({ error: 'invalid_namespace' })
      }
      return sendDiscoveryDocument(reply, request.headers.origin, async () => {
        const ctx = metadataContext(nsResult.data)
        if (!ctx) return null
        return getAuthorizationServerMetadataDocument(ctx.oauth, ctx.issuer, nsResult.data)
      })
    },
  )

  app.get('/.well-known/oauth-authorization-server', async (request, reply) => {
    return sendDiscoveryDocument(reply, request.headers.origin, async () => {
      const ctx = metadataContext()
      if (!ctx) return null
      return getAuthorizationServerMetadataDocument(ctx.oauth, ctx.issuer)
    })
  })

  app.get<{ Params: { namespace: string } }>(
    '/.well-known/openid-configuration/mcp/:namespace',
    async (request, reply) => {
      const nsResult = NamespaceSchema.safeParse(request.params.namespace)
      if (!nsResult.success) {
        return reply.status(400).send({ error: 'invalid_namespace' })
      }
      return sendDiscoveryDocument(reply, request.headers.origin, async () => {
        const ctx = metadataContext(nsResult.data)
        if (!ctx) return null
        return getOpenIdConfigurationDocument(ctx.oauth, ctx.issuer, nsResult.data)
      })
    },
  )

  app.get<{ Params: { namespace: string } }>(
    '/mcp/:namespace/.well-known/openid-configuration',
    async (request, reply) => {
      const nsResult = NamespaceSchema.safeParse(request.params.namespace)
      if (!nsResult.success) {
        return reply.status(400).send({ error: 'invalid_namespace' })
      }
      return sendDiscoveryDocument(reply, request.headers.origin, async () => {
        const ctx = metadataContext(nsResult.data)
        if (!ctx) return null
        return getOpenIdConfigurationDocument(ctx.oauth, ctx.issuer, nsResult.data)
      })
    },
  )

  app.get('/.well-known/openid-configuration', async (request, reply) => {
    return sendDiscoveryDocument(reply, request.headers.origin, async () => {
      const ctx = metadataContext()
      if (!ctx) return null
      return getOpenIdConfigurationDocument(ctx.oauth, ctx.issuer)
    })
  })

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
