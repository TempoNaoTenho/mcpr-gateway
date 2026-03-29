import type { FastifyInstance, FastifyReply } from 'fastify'
import { getConfig } from '../../config/index.js'
import { NamespaceSchema } from '../../types/identity.js'
import { getInboundOAuth, oauthAppliesToNamespace } from '../../auth/oauth-config.js'
import {
  getAuthorizationServerMetadataDocument,
  getOpenIdConfigurationDocument,
} from '../../auth/oauth-issuer-metadata.js'
import { setMcpCorsHeaders } from '../cors.js'
import { getRequestOrigin } from '../request-origin.js'

function protectedResourceBody(namespace: string, requestOrigin?: string) {
  const oauth = getInboundOAuth(getConfig().auth, requestOrigin)
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

function metadataFailureReason(namespace?: string, requestOrigin?: string): Record<string, unknown> {
  const config = getConfig()
  const oauth = getInboundOAuth(config.auth, requestOrigin)
  const namespaceExists = namespace ? Boolean(config.namespaces[namespace]) : undefined
  const oauthEnabled = Boolean(oauth)
  const oauthApplies =
    namespace && oauth
      ? oauthAppliesToNamespace(oauth, namespace, new Set(Object.keys(config.namespaces)))
      : undefined

  return {
    authMode: config.auth.mode,
    namespace,
    namespaceExists,
    oauthEnabled,
    oauthApplies,
    configuredNamespaces: Object.keys(config.namespaces),
  }
}

function logMetadata404(app: FastifyInstance, route: string, namespace?: string, requestOrigin?: string): void {
  app.log.info(
    metadataFailureReason(namespace, requestOrigin),
    `[oauth-metadata] returning 404 for ${route}`,
  )
}

function metadataContext(namespace?: string, requestOrigin?: string): {
  oauth: NonNullable<ReturnType<typeof getInboundOAuth>>
  issuer: NonNullable<ReturnType<typeof getInboundOAuth>>['authorizationServers'][number]
} | null {
  const config = getConfig()
  const oauth = getInboundOAuth(config.auth, requestOrigin)
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
  app: FastifyInstance,
  reply: FastifyReply,
  origin: string | undefined,
  route: string,
  namespace: string | undefined,
  requestOrigin: string | undefined,
  builder: () => Promise<Record<string, unknown> | null>,
) {
  const allowedOrigins = getInboundOAuth(getConfig().auth, requestOrigin)?.allowedBrowserOrigins
  setMcpCorsHeaders(reply, origin, allowedOrigins)
  const body = await builder()
  if (!body) {
    logMetadata404(app, route, namespace, requestOrigin)
    return reply.status(404).send({ error: 'not_found' })
  }
  return reply.header('Content-Type', 'application/json; charset=utf-8').send(body)
}

function embeddedAuthorizationServerDocument(
  oauth: NonNullable<ReturnType<typeof getInboundOAuth>>,
  namespace?: string,
): Record<string, unknown> {
  const base = oauth.publicBaseUrl.replace(/\/$/, '')
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: oauth.scopesSupported?.length ? oauth.scopesSupported : ['openid'],
    ...(namespace ? { resource: `${base}/mcp/${namespace}` } : {}),
  }
}

export async function oauthMetadataRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onReady', async () => {
    const config = getConfig()
    const oauth = getInboundOAuth(config.auth)
    if (!oauth) {
      const message =
        config.auth.mode === 'hybrid'
          ? '[oauth-metadata] inbound OAuth metadata routes mounted in passive mode (auth.mode=hybrid, oauthReady=false)'
          : '[oauth-metadata] inbound OAuth metadata routes mounted in passive mode (auth.mode=static_key)'
      app.log.info(message)
      return
    }

    app.log.info(
      {
        authMode: config.auth.mode,
        publicBaseUrl: oauth.publicBaseUrl,
        issuers: oauth.authorizationServers.map((issuer) => issuer.issuer.replace(/\/$/, '')),
        protectedNamespaces: oauth.requireForNamespaces ?? 'all',
      },
      '[oauth-metadata] inbound OAuth metadata routes mounted',
    )
  })

  app.get<{ Params: { namespace: string } }>(
    '/.well-known/oauth-protected-resource/mcp/:namespace',
    async (request, reply) => {
      const requestOrigin = getRequestOrigin(request)
      const allowedOrigins = getInboundOAuth(getConfig().auth, requestOrigin)?.allowedBrowserOrigins
      setMcpCorsHeaders(reply, request.headers.origin, allowedOrigins)
      const nsResult = NamespaceSchema.safeParse(request.params.namespace)
      if (!nsResult.success) {
        return reply.status(400).send({ error: 'invalid_namespace' })
      }
      const body = protectedResourceBody(nsResult.data, requestOrigin)
      if (!body) {
        logMetadata404(app, '/.well-known/oauth-protected-resource/mcp/:namespace', nsResult.data, requestOrigin)
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
      const requestOrigin = getRequestOrigin(request)
      return sendDiscoveryDocument(
        app,
        reply,
        request.headers.origin,
        '/.well-known/oauth-authorization-server/mcp/:namespace',
        nsResult.data,
        requestOrigin,
        async () => {
        const ctx = metadataContext(nsResult.data, requestOrigin)
        if (!ctx) return null
        if (ctx.oauth.provider === 'embedded') return embeddedAuthorizationServerDocument(ctx.oauth, nsResult.data)
        return getAuthorizationServerMetadataDocument(ctx.oauth, ctx.issuer, nsResult.data)
        },
      )
    },
  )

  app.get<{ Params: { namespace: string } }>(
    '/mcp/:namespace/.well-known/oauth-authorization-server',
    async (request, reply) => {
      const nsResult = NamespaceSchema.safeParse(request.params.namespace)
      if (!nsResult.success) {
        return reply.status(400).send({ error: 'invalid_namespace' })
      }
      const requestOrigin = getRequestOrigin(request)
      return sendDiscoveryDocument(
        app,
        reply,
        request.headers.origin,
        '/mcp/:namespace/.well-known/oauth-authorization-server',
        nsResult.data,
        requestOrigin,
        async () => {
        const ctx = metadataContext(nsResult.data, requestOrigin)
        if (!ctx) return null
        if (ctx.oauth.provider === 'embedded') return embeddedAuthorizationServerDocument(ctx.oauth, nsResult.data)
        return getAuthorizationServerMetadataDocument(ctx.oauth, ctx.issuer, nsResult.data)
        },
      )
    },
  )

  app.get('/.well-known/oauth-authorization-server', async (request, reply) => {
    const requestOrigin = getRequestOrigin(request)
    return sendDiscoveryDocument(
      app,
      reply,
      request.headers.origin,
      '/.well-known/oauth-authorization-server',
      undefined,
      requestOrigin,
      async () => {
      const ctx = metadataContext(undefined, requestOrigin)
      if (!ctx) return null
      if (ctx.oauth.provider === 'embedded') return embeddedAuthorizationServerDocument(ctx.oauth)
      return getAuthorizationServerMetadataDocument(ctx.oauth, ctx.issuer)
      },
    )
  })

  app.get<{ Params: { namespace: string } }>(
    '/.well-known/openid-configuration/mcp/:namespace',
    async (request, reply) => {
      const nsResult = NamespaceSchema.safeParse(request.params.namespace)
      if (!nsResult.success) {
        return reply.status(400).send({ error: 'invalid_namespace' })
      }
      const requestOrigin = getRequestOrigin(request)
      return sendDiscoveryDocument(
        app,
        reply,
        request.headers.origin,
        '/.well-known/openid-configuration/mcp/:namespace',
        nsResult.data,
        requestOrigin,
        async () => {
        const ctx = metadataContext(nsResult.data, requestOrigin)
        if (!ctx) return null
        if (ctx.oauth.provider === 'embedded') return embeddedAuthorizationServerDocument(ctx.oauth, nsResult.data)
        return getOpenIdConfigurationDocument(ctx.oauth, ctx.issuer, nsResult.data)
        },
      )
    },
  )

  app.get<{ Params: { namespace: string } }>(
    '/mcp/:namespace/.well-known/openid-configuration',
    async (request, reply) => {
      const nsResult = NamespaceSchema.safeParse(request.params.namespace)
      if (!nsResult.success) {
        return reply.status(400).send({ error: 'invalid_namespace' })
      }
      const requestOrigin = getRequestOrigin(request)
      return sendDiscoveryDocument(
        app,
        reply,
        request.headers.origin,
        '/mcp/:namespace/.well-known/openid-configuration',
        nsResult.data,
        requestOrigin,
        async () => {
        const ctx = metadataContext(nsResult.data, requestOrigin)
        if (!ctx) return null
        if (ctx.oauth.provider === 'embedded') return embeddedAuthorizationServerDocument(ctx.oauth, nsResult.data)
        return getOpenIdConfigurationDocument(ctx.oauth, ctx.issuer, nsResult.data)
        },
      )
    },
  )

  app.get('/.well-known/openid-configuration', async (request, reply) => {
    const requestOrigin = getRequestOrigin(request)
    return sendDiscoveryDocument(
      app,
      reply,
      request.headers.origin,
      '/.well-known/openid-configuration',
      undefined,
      requestOrigin,
      async () => {
      const ctx = metadataContext(undefined, requestOrigin)
      if (!ctx) return null
      if (ctx.oauth.provider === 'embedded') return embeddedAuthorizationServerDocument(ctx.oauth)
      return getOpenIdConfigurationDocument(ctx.oauth, ctx.issuer)
      },
    )
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
        logMetadata404(app, '/mcp/:namespace/.well-known/oauth-protected-resource', nsResult.data)
        return reply.status(404).send({ error: 'not_found' })
      }
      return reply.header('Content-Type', 'application/json; charset=utf-8').send(body)
    },
  )
}
