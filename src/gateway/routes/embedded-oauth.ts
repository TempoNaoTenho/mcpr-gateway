import { createHash, createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'
import { getConfig } from '../../config/index.js'
import type { RuntimeConfigManager } from '../../config/runtime.js'
import { getInboundOAuth } from '../../auth/oauth-config.js'
import {
  authCookieHeaders,
  createAdminSession,
  getGatewayAdminPassword,
  getGatewayAdminUser,
  sessionFromCookies,
  validateAdminCredentials,
} from '../admin-auth-session.js'
import { getRequestOrigin } from '../request-origin.js'

type EmbeddedOAuthRouteOptions = {
  configManager: RuntimeConfigManager
}

type RegisteredClient = {
  clientId: string
  redirectUris: string[]
  createdAt: number
}

type AuthorizationCodeRecord = {
  clientId: string
  redirectUri: string
  namespace: string
  sub: string
  roles: string[]
  codeChallenge?: string
  codeChallengeMethod?: string
  expiresAt: number
}

const registeredClients = new Map<string, RegisteredClient>()
const authorizationCodes = new Map<string, AuthorizationCodeRecord>()
const AUTH_CODE_TTL_MS = 5 * 60 * 1000

function normalizeProvider(
  auth: ReturnType<RuntimeConfigManager['getAdminConfig']>['auth'],
): 'embedded' | 'external' | 'none' {
  if (auth.mode !== 'oauth' && auth.mode !== 'hybrid') return 'none'
  return auth.oauth.provider ?? (auth.oauth.authorizationServers.length > 0 ? 'external' : 'embedded')
}

function embeddedKeyMaterial(auth: ReturnType<RuntimeConfigManager['getAdminConfig']>['auth']) {
  if (auth.mode !== 'oauth' && auth.mode !== 'hybrid') return undefined
  if (normalizeProvider(auth) !== 'embedded') return undefined
  const embedded = auth.oauth.embedded
  if (!embedded?.privateJwk || !embedded.publicJwk || !embedded.keyId) return undefined
  return embedded
}

function generateEmbeddedKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyId = randomUUID()
  const privateJwk = {
    ...(privateKey.export({ format: 'jwk' }) as Record<string, unknown>),
    alg: 'ES256',
    use: 'sig',
    kid: keyId,
  }
  const publicJwk = {
    ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    alg: 'ES256',
    use: 'sig',
    kid: keyId,
  }
  return { keyId, privateJwk, publicJwk }
}

async function ensureEmbeddedKeys(configManager: RuntimeConfigManager): Promise<void> {
  const current = configManager.getAdminConfig()
  if (normalizeProvider(current.auth) !== 'embedded') return
  if (embeddedKeyMaterial(current.auth)) return

  const keys = generateEmbeddedKeys()
  await configManager.saveAdminConfig(
    {
      ...current,
      auth:
        current.auth.mode === 'oauth'
          ? {
              mode: 'oauth',
              oauth: {
                ...current.auth.oauth,
                provider: 'embedded',
                embedded: keys,
              },
            }
          : current.auth.mode === 'hybrid'
            ? {
              mode: 'hybrid',
              staticKeys: current.auth.staticKeys,
              oauth: {
                ...current.auth.oauth,
                provider: 'embedded',
                embedded: keys,
              },
            }
            : current.auth,
    },
    {
      source: 'ui_edit',
      createdBy: 'system',
      comment: 'Initialize embedded OAuth signing keys',
    },
  )
}

function oauthIdentityFromRequest(request: { cookies?: Record<string, string> }): { sub: string; roles: string[] } | null {
  const adminPassword = getGatewayAdminPassword()
  const cookies = request.cookies
  if (sessionFromCookies(cookies)) {
    return { sub: getGatewayAdminUser(), roles: ['admin', 'user'] }
  }
  if (!adminPassword) {
    return { sub: getGatewayAdminUser(), roles: ['admin', 'user'] }
  }
  return null
}

function namespaceFromResource(resource: string | undefined): string {
  const config = getConfig()
  if (typeof resource === 'string' && resource.length > 0) {
    for (const namespace of Object.keys(config.namespaces)) {
      if (resource.endsWith(`/mcp/${namespace}`)) {
        return namespace
      }
    }
  }
  if (config.namespaces['default']) return 'default'
  return Object.keys(config.namespaces)[0] ?? 'default'
}

function verifyPkce(codeVerifier: string | undefined, record: AuthorizationCodeRecord): boolean {
  if (!record.codeChallenge) return true
  if (!codeVerifier) return false
  const method = record.codeChallengeMethod ?? 'plain'
  if (method === 'plain') return codeVerifier === record.codeChallenge
  if (method !== 'S256') return false
  const digest = createHash('sha256').update(codeVerifier).digest('base64url')
  return digest === record.codeChallenge
}

function loginPage(query: URLSearchParams, message?: string): string {
  const hidden = [...query.entries()]
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${value.replace(/"/g, '&quot;')}">`)
    .join('\n')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authorize MCP App</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
      form { background:#111827; padding:24px; border-radius:16px; width:min(420px, 92vw); border:1px solid #334155; }
      label { display:block; margin:0 0 14px; font-size:14px; }
      input { width:100%; box-sizing:border-box; margin-top:6px; padding:10px 12px; border-radius:10px; border:1px solid #475569; background:#0f172a; color:#f8fafc; }
      button { width:100%; padding:12px; border-radius:10px; border:none; background:#2563eb; color:white; font-weight:600; }
      .msg { margin:0 0 14px; color:#fca5a5; font-size:13px; }
      p { color:#cbd5e1; font-size:14px; line-height:1.5; }
    </style>
  </head>
  <body>
    <form method="post" action="/oauth/authorize">
      <h1>Connect MCP app</h1>
      <p>Sign in to authorize this MCP client.</p>
      ${message ? `<p class="msg">${message}</p>` : ''}
      ${hidden}
      <label>Username<input name="username" autocomplete="username"></label>
      <label>Password<input type="password" name="password" autocomplete="current-password"></label>
      <button type="submit">Continue</button>
    </form>
  </body>
</html>`
}

async function issueAccessToken(
  auth: ReturnType<RuntimeConfigManager['getAdminConfig']>['auth'],
  publicBaseUrl: string,
  sub: string,
  roles: string[],
  namespace: string,
): Promise<string> {
  const embedded = embeddedKeyMaterial(auth)
  if (!embedded?.privateJwk || !embedded.keyId) {
    throw new Error('Embedded OAuth signing keys are not initialized')
  }
  const privateKey = createPrivateKey({ key: embedded.privateJwk as never, format: 'jwk' })
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: 'ES256', kid: embedded.keyId, typ: 'JWT' })
    .setIssuer(publicBaseUrl)
    .setSubject(sub)
    .setAudience(`${publicBaseUrl}/mcp/${namespace}`)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

export async function embeddedOAuthRoutes(app: FastifyInstance, opts: EmbeddedOAuthRouteOptions): Promise<void> {
  app.addContentTypeParser(/^application\/x-www-form-urlencoded(?:;.*)?$/i, { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body.toString())))
  })

  app.addHook('onReady', async () => {
    await ensureEmbeddedKeys(opts.configManager)
  })

  app.get('/.well-known/jwks.json', async (request, reply) => {
    const auth = opts.configManager.getEffective().auth
    if (normalizeProvider(auth) !== 'embedded') {
      return reply.status(404).send({ error: 'not_found' })
    }
    const embedded = embeddedKeyMaterial(auth)
    if (!embedded?.publicJwk) {
      return reply.status(503).send({ error: 'oauth_not_ready' })
    }
    return reply.send({ keys: [embedded.publicJwk] })
  })

  app.post('/oauth/register', async (request, reply) => {
    const auth = opts.configManager.getEffective().auth
    if (normalizeProvider(auth) !== 'embedded') {
      return reply.status(404).send({ error: 'not_found' })
    }
    const body = request.body as { redirect_uris?: unknown; client_name?: string } | undefined
    const redirectUris = Array.isArray(body?.redirect_uris)
      ? body.redirect_uris.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : []
    if (redirectUris.length === 0) {
      return reply.status(400).send({ error: 'invalid_client_metadata' })
    }
    const clientId = nanoid(24)
    registeredClients.set(clientId, {
      clientId,
      redirectUris,
      createdAt: Date.now(),
    })
    return reply.status(201).send({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(typeof body?.client_name === 'string' ? { client_name: body.client_name } : {}),
    })
  })

  app.get('/oauth/authorize', async (request, reply) => {
    const auth = opts.configManager.getEffective().auth
    if (normalizeProvider(auth) !== 'embedded') {
      return reply.status(404).send({ error: 'not_found' })
    }

    const query = request.query as Record<string, string | undefined>
    const clientId = query['client_id']
    const redirectUri = query['redirect_uri']
    const responseType = query['response_type']
    if (!clientId || !redirectUri || responseType !== 'code') {
      return reply.status(400).send({ error: 'invalid_request' })
    }
    const client = registeredClients.get(clientId)
    if (!client || !client.redirectUris.includes(redirectUri)) {
      return reply.status(400).send({ error: 'unauthorized_client' })
    }

    const identity = oauthIdentityFromRequest(request as never)
    if (!identity) {
      return reply.type('text/html; charset=utf-8').send(loginPage(new URLSearchParams(query as Record<string, string>)))
    }

    const publicBaseUrl = getInboundOAuth(auth, getRequestOrigin(request))?.publicBaseUrl
    if (!publicBaseUrl) {
      return reply.status(503).send({ error: 'oauth_not_ready' })
    }
    const namespace = namespaceFromResource(query['resource'])
    const code = nanoid(32)
    authorizationCodes.set(code, {
      clientId,
      redirectUri,
      namespace,
      sub: identity.sub,
      roles: identity.roles,
      codeChallenge: query['code_challenge'],
      codeChallengeMethod: query['code_challenge_method'],
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    })

    const next = new URL(redirectUri)
    next.searchParams.set('code', code)
    if (query['state']) next.searchParams.set('state', query['state'])
    return reply.redirect(next.toString())
  })

  app.post('/oauth/authorize', async (request, reply) => {
    const auth = opts.configManager.getEffective().auth
    if (normalizeProvider(auth) !== 'embedded') {
      return reply.status(404).send({ error: 'not_found' })
    }

    const body = request.body as Record<string, string | undefined>
    if (!validateAdminCredentials(body['username'], body['password'])) {
      const copy = { ...body }
      delete copy['password']
      return reply.type('text/html; charset=utf-8').send(loginPage(new URLSearchParams(copy as Record<string, string>), 'Invalid credentials'))
    }
    const sessionId = createAdminSession()
    const isProduction = process.env['NODE_ENV'] === 'production'
    reply.headers({
      'Set-Cookie': authCookieHeaders(sessionId, isProduction),
    })
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(body)) {
      if (key === 'username' || key === 'password' || typeof value !== 'string') continue
      params.set(key, value)
    }
    return reply.redirect(`/oauth/authorize?${params.toString()}`)
  })

  app.post('/oauth/token', async (request, reply) => {
    const auth = opts.configManager.getEffective().auth
    if (normalizeProvider(auth) !== 'embedded') {
      return reply.status(404).send({ error: 'not_found' })
    }

    const body = request.body as Record<string, string | undefined>
    if (body['grant_type'] !== 'authorization_code') {
      return reply.status(400).send({ error: 'unsupported_grant_type' })
    }
    const code = body['code']
    const clientId = body['client_id']
    const redirectUri = body['redirect_uri']
    if (!code || !clientId || !redirectUri) {
      return reply.status(400).send({ error: 'invalid_request' })
    }
    const client = registeredClients.get(clientId)
    const record = authorizationCodes.get(code)
    if (!client || !record) {
      return reply.status(400).send({ error: 'invalid_grant' })
    }
    if (record.expiresAt < Date.now()) {
      authorizationCodes.delete(code)
      return reply.status(400).send({ error: 'invalid_grant' })
    }
    if (record.clientId !== clientId || record.redirectUri !== redirectUri || !client.redirectUris.includes(redirectUri)) {
      return reply.status(400).send({ error: 'invalid_grant' })
    }
    if (!verifyPkce(body['code_verifier'], record)) {
      return reply.status(400).send({ error: 'invalid_grant' })
    }

    const publicBaseUrl = getInboundOAuth(auth, getRequestOrigin(request))?.publicBaseUrl
    if (!publicBaseUrl) {
      return reply.status(503).send({ error: 'oauth_not_ready' })
    }
    authorizationCodes.delete(code)
    const accessToken = await issueAccessToken(auth, publicBaseUrl, record.sub, record.roles, record.namespace)
    return reply.send({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid',
    })
  })
}
