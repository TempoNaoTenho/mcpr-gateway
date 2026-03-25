import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { DownstreamAuthState, DownstreamServer } from '../../types/server.js'
import { DownstreamAuthStatus } from '../../types/enums.js'
import type { IDownstreamAuthRepository } from '../../repositories/downstreamAuth/interface.js'
import { DownstreamAuthError } from './errors.js'
import { isAllowedOAuthUrl } from '../../security/url-validation.js'
import { GatewayError, GatewayErrorCode } from '../../types/errors.js'
import { getConfig } from '../../config/index.js'

type BearerSecretPayload = {
  token: string
}

type OAuthTokenPayload = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  tokenType?: string
  scope?: string
  clientId?: string
  clientSecret?: string
  tokenEndpointAuthMethod?: string
  authorizationServer?: string
  resource?: string
}

type OAuthPendingState = {
  serverId: string
  state: string
  codeVerifier: string
  redirectUri: string
  createdAt: number
  clientId?: string
  clientSecret?: string
  tokenEndpointAuthMethod?: string
  resource?: string
}

type AuthStateInternal = DownstreamAuthState

type OAuthDiscovery = {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  authorizationServer: string
  resource?: string
}

type OAuthClientCredentials = {
  clientId?: string
  clientSecret?: string
  tokenEndpointAuthMethod?: string
}

const OAUTH_PENDING_STATE_TTL_MS = 10 * 60 * 1000

function buildDefaultState(server: DownstreamServer): AuthStateInternal {
  const legacyAuth =
    typeof server.headers?.['Authorization'] === 'string' &&
    server.headers['Authorization'].trim().length > 0
  return {
    serverId: server.id,
    status: server.auth || legacyAuth ? DownstreamAuthStatus.Configured : DownstreamAuthStatus.None,
    managedSecretConfigured: false,
  }
}

function normalizeSecretKey(raw: string | undefined): Buffer | undefined {
  if (!raw) return undefined
  try {
    const buf = Buffer.from(raw, 'base64')
    return buf.length === 32 ? buf : undefined
  } catch {
    return undefined
  }
}

function encodeCiphertext(
  payload: unknown,
  key: Buffer
): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

function decodeCiphertext<T>(
  input: { ciphertext: string; iv: string; tag: string },
  key: Buffer
): T {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(input.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(input.tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(input.ciphertext, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString('utf8')) as T
}

function extractAuthHeaderValue(server: DownstreamServer): string | undefined {
  const value = server.headers?.['Authorization']
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function normalizeToken(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function makeCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function makeCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function extractAuthorizationServer(challenge?: string): string | undefined {
  if (!challenge) return undefined
  const authUri = challenge.match(/authorization_uri=\"([^\"]+)\"/i)?.[1]
  if (authUri) return authUri
  const resourceMetadata = challenge.match(/resource_metadata=\"([^\"]+)\"/i)?.[1]
  return resourceMetadata
}

function buildDiscoveryUrls(authorizationServer: string): string[] {
  if (authorizationServer.includes('/.well-known/')) return [authorizationServer]
  const base = authorizationServer.replace(/\/+$/, '')
  return [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ]
}

function extractOAuthAuthorizationServers(body: Record<string, unknown>): string[] {
  const servers = body['authorization_servers']
  if (Array.isArray(servers)) {
    return servers.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  }
  const singleServer = body['authorization_server']
  if (typeof singleServer === 'string' && singleServer.length > 0) {
    return [singleServer]
  }
  return []
}

function normalizeTokenEndpointAuthMethod(
  authMethod: string | undefined,
  clientSecret: string | undefined
): string {
  if (authMethod === 'client_secret_basic' || authMethod === 'client_secret_post') {
    return authMethod
  }
  if (authMethod === 'none') {
    return 'none'
  }
  return clientSecret ? 'client_secret_basic' : 'none'
}

export class DownstreamAuthManager {
  private readonly states = new Map<string, AuthStateInternal>()
  private readonly servers = new Map<string, DownstreamServer>()
  private readonly pendingOAuth = new Map<string, OAuthPendingState>()
  private repo: IDownstreamAuthRepository | undefined

  constructor(repo?: IDownstreamAuthRepository) {
    this.repo = repo
  }

  setRepository(repo?: IDownstreamAuthRepository): void {
    this.repo = repo
  }

  private getEncryptionKey(): Buffer | undefined {
    return normalizeSecretKey(process.env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'])
  }

  private supportsManagedCredentials(): boolean {
    return Boolean(this.repo && this.getEncryptionKey())
  }

  private isPendingOAuthExpired(pending: OAuthPendingState): boolean {
    return Date.now() - pending.createdAt > OAUTH_PENDING_STATE_TTL_MS
  }

  private pruneExpiredPendingOAuth(): void {
    for (const [state, pending] of this.pendingOAuth) {
      if (this.isPendingOAuthExpired(pending)) {
        this.pendingOAuth.delete(state)
      }
    }
  }

  private buildOAuthTokenRequest(
    credentials: OAuthClientCredentials,
    params: URLSearchParams
  ): { headers: Record<string, string>; body: URLSearchParams } {
    const clientSecret = normalizeToken(credentials.clientSecret)
    const authMethod = normalizeTokenEndpointAuthMethod(
      normalizeToken(credentials.tokenEndpointAuthMethod),
      clientSecret
    )
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    }

    if (authMethod === 'client_secret_basic' && credentials.clientId && clientSecret) {
      headers['Authorization'] = `Basic ${Buffer.from(
        `${credentials.clientId}:${clientSecret}`,
        'utf8'
      ).toString('base64')}`
      return { headers, body: params }
    }

    if (credentials.clientId) {
      params.set('client_id', credentials.clientId)
    }

    if (authMethod === 'client_secret_post' && clientSecret) {
      params.set('client_secret', clientSecret)
    }

    return { headers, body: params }
  }

  private async validateOAuthUrl(url: string): Promise<void> {
    const allowlist = getConfig().allowedOAuthProviders ?? []
    const allowed = await isAllowedOAuthUrl(url, allowlist)
    if (!allowed) {
      throw new GatewayError(
        GatewayErrorCode.OAUTH_PROVIDER_NOT_ALLOWED,
        `OAuth provider URL is not allowed: ${url}`,
        { url }
      )
    }
  }

  private async validateOAuthFetchUrl(url: string): Promise<void> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new GatewayError(
        GatewayErrorCode.OAUTH_PROVIDER_NOT_ALLOWED,
        `OAuth metadata URL is not allowed: ${url}`,
        { url }
      )
    }

    if (parsed.protocol !== 'https:') {
      throw new GatewayError(
        GatewayErrorCode.OAUTH_PROVIDER_NOT_ALLOWED,
        `OAuth metadata URL is not allowed: ${url}`,
        { url }
      )
    }

    const hostname = parsed.hostname.toLowerCase()
    const isPrivateIpv4 =
      /^(10|127)\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
      /^192\.168\./.test(hostname)
    const isPrivateIpv6 =
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname === '0.0.0.0' ||
      hostname.startsWith('fc00:') ||
      hostname.startsWith('fe80:') ||
      hostname.startsWith('::ffff:')

    if (isPrivateIpv4 || isPrivateIpv6) {
      throw new GatewayError(
        GatewayErrorCode.OAUTH_PROVIDER_NOT_ALLOWED,
        `OAuth metadata URL is not allowed: ${url}`,
        { url }
      )
    }
  }

  private async getOAuthAuthorizationServer(server: DownstreamServer): Promise<string | undefined> {
    const state = this.states.get(server.id)
    const tokens = await this.getOAuthTokens(server.id)

    if (server.auth?.mode === 'bearer') {
      return undefined
    }

    if (server.auth?.mode === 'oauth') {
      return server.auth.authorizationServer ?? state?.authorizationServer ?? tokens?.authorizationServer
    }

    return state?.authorizationServer ?? tokens?.authorizationServer
  }

  getCapabilities(): {
    managedSecretsEnabled: boolean
    oauthStorageEnabled: boolean
  } {
    const enabled = this.supportsManagedCredentials()
    return {
      managedSecretsEnabled: enabled,
      oauthStorageEnabled: enabled,
    }
  }

  syncServers(servers: DownstreamServer[]): void {
    const nextIds = new Set(servers.map((server) => server.id))
    this.servers.clear()
    for (const server of servers) {
      this.servers.set(server.id, server)
      this.states.set(server.id, this.states.get(server.id) ?? buildDefaultState(server))
    }

    for (const serverId of [...this.states.keys()]) {
      if (!nextIds.has(serverId)) {
        this.states.delete(serverId)
      }
    }
  }

  private getServer(serverId: string): DownstreamServer {
    const server = this.servers.get(serverId)
    if (!server) throw new Error(`[downstream-auth] Unknown server: ${serverId}`)
    return server
  }

  async getState(serverId: string): Promise<DownstreamAuthState> {
    const server = this.servers.get(serverId)
    if (!server) {
      return {
        serverId,
        status: DownstreamAuthStatus.None,
        managedSecretConfigured: false,
      }
    }
    const state = this.states.get(serverId) ?? buildDefaultState(server)
    const credentials = this.repo ? await this.repo.listByServer(serverId) : []
    return {
      ...state,
      managedSecretConfigured: credentials.length > 0,
    }
  }

  async resolveAuthHeaders(server: DownstreamServer): Promise<Record<string, string>> {
    const auth = server.auth
    const legacyAuthorization = extractAuthHeaderValue(server)

    if (!auth) {
      if (legacyAuthorization) {
        this.states.set(server.id, {
          ...(this.states.get(server.id) ?? buildDefaultState(server)),
          status: DownstreamAuthStatus.Authorized,
        })
      }
      const tokens = await this.getOAuthTokens(server.id)
      if (!tokens) return {}
      const freshTokens = await this.ensureFreshOAuthTokens(server, tokens)
      return {
        Authorization: `${freshTokens.tokenType ?? 'Bearer'} ${freshTokens.accessToken}`,
      }
    }

    if (auth.mode === 'none') {
      const tokens = await this.getOAuthTokens(server.id)
      if (!tokens) return {}
      const freshTokens = await this.ensureFreshOAuthTokens(server, tokens)
      return {
        Authorization: `${freshTokens.tokenType ?? 'Bearer'} ${freshTokens.accessToken}`,
      }
    }

    if (auth.mode === 'bearer') {
      const headerName = auth.headerName ?? 'Authorization'
      const scheme = auth.scheme ?? 'Bearer'
      let token: string | undefined
      if (auth.source.type === 'env') {
        token = normalizeToken(process.env[auth.source.envVar])
      } else if (auth.source.type === 'literal') {
        token = normalizeToken(auth.source.value)
      } else {
        const key = this.getEncryptionKey()
        if (!this.repo || !key) {
          this.states.set(server.id, {
            ...(this.states.get(server.id) ?? buildDefaultState(server)),
            status: DownstreamAuthStatus.Misconfigured,
            message: 'Managed downstream secrets require SQLite and DOWNSTREAM_AUTH_ENCRYPTION_KEY',
          })
          throw new DownstreamAuthError(
            `[registry/http] Server ${server.id} requires a managed bearer secret`,
            { serverId: server.id, kind: 'misconfigured' }
          )
        }
        const stored = await this.repo.get(server.id, 'bearer')
        if (!stored) {
          this.states.set(server.id, {
            ...(this.states.get(server.id) ?? buildDefaultState(server)),
            status: DownstreamAuthStatus.AuthRequired,
            message: 'Managed bearer secret not configured',
          })
          throw new DownstreamAuthError(
            `[registry/http] Server ${server.id} requires a managed bearer secret`,
            { serverId: server.id, kind: 'auth_required' }
          )
        }
        token = normalizeToken(decodeCiphertext<BearerSecretPayload>(stored, key).token)
      }

      if (!token) {
        this.states.set(server.id, {
          ...(this.states.get(server.id) ?? buildDefaultState(server)),
          status: DownstreamAuthStatus.Misconfigured,
          message:
            auth.source.type === 'env'
              ? `Missing environment variable ${auth.source.envVar}`
              : 'Bearer token is empty',
        })
        throw new DownstreamAuthError(
          `[registry/http] Server ${server.id} is missing bearer credentials`,
          { serverId: server.id, kind: 'misconfigured' }
        )
      }

      this.states.set(server.id, {
        ...(this.states.get(server.id) ?? buildDefaultState(server)),
        status: DownstreamAuthStatus.Configured,
      })

      return {
        [headerName]: scheme ? `${scheme} ${token}` : token,
      }
    }

    const tokens = await this.getOAuthTokens(server.id)
    if (!tokens) {
      this.states.set(server.id, {
        ...(this.states.get(server.id) ?? buildDefaultState(server)),
        status: DownstreamAuthStatus.AuthRequired,
        message: 'OAuth authorization is required',
      })
      throw new DownstreamAuthError(
        `[registry/http] Server ${server.id} requires OAuth authorization`,
        { serverId: server.id, kind: 'auth_required' }
      )
    }

    const freshTokens = await this.ensureFreshOAuthTokens(server, tokens)
    return {
      Authorization: `${freshTokens.tokenType ?? 'Bearer'} ${freshTokens.accessToken}`,
    }
  }

  markAuthorized(serverId: string): void {
    const current = this.states.get(serverId)
    if (!current) return
    this.states.set(serverId, {
      ...current,
      status: DownstreamAuthStatus.Authorized,
      message: undefined,
      lastAuthenticatedAt: new Date().toISOString(),
    })
  }

  async handleUnauthorized(serverId: string, challenge?: string): Promise<never> {
    const server = this.getServer(serverId)
    const current = this.states.get(serverId) ?? buildDefaultState(server)
    const hasBearerAuth =
      server.auth?.mode === 'bearer' || typeof extractAuthHeaderValue(server) === 'string'
    const hasOAuthAuth = server.auth?.mode === 'oauth'
    const message = hasBearerAuth
      ? 'Downstream server rejected the configured bearer credentials'
      : hasOAuthAuth
        ? 'Downstream server rejected the configured OAuth credentials'
        : 'Downstream server requires authentication'
    const kind =
      hasBearerAuth || (hasOAuthAuth && current.status !== DownstreamAuthStatus.None)
        ? ('invalid_token' as const)
        : ('auth_required' as const)
    const nextState: AuthStateInternal = {
      ...current,
      status: DownstreamAuthStatus.AuthRequired,
      message,
      challenge,
      authorizationServer: extractAuthorizationServer(challenge),
    }
    this.states.set(serverId, nextState)
    throw new DownstreamAuthError(
      `[registry/http] Server ${server.id} returned HTTP 401 from ${server.url}`,
      {
        serverId,
        kind,
        status: 401,
        challenge,
        authorizationServer: nextState.authorizationServer,
      }
    )
  }

  async saveManagedBearer(serverId: string, token: string): Promise<void> {
    const key = this.getEncryptionKey()
    if (!this.repo || !key) {
      throw new Error(
        'Managed downstream secrets require SQLite and DOWNSTREAM_AUTH_ENCRYPTION_KEY'
      )
    }
    const encrypted = encodeCiphertext({ token }, key)
    await this.repo.save({
      serverId,
      kind: 'bearer',
      ...encrypted,
      updatedAt: Date.now(),
    })
    const state = await this.getState(serverId)
    this.states.set(serverId, {
      ...state,
      status: DownstreamAuthStatus.Configured,
      message: undefined,
    })
  }

  async disconnect(serverId: string): Promise<void> {
    await this.repo?.delete(serverId)
    const server = this.getServer(serverId)
    this.states.set(serverId, buildDefaultState(server))
  }

  async beginOAuth(serverId: string, origin: string): Promise<{ authorizeUrl: string }> {
    this.pruneExpiredPendingOAuth()

    const server = this.getServer(serverId)
    const auth = server.auth
    const authorizationServer = await this.getOAuthAuthorizationServer(server)
    if (!authorizationServer) {
      throw new Error(`Server ${serverId} is not configured for OAuth`)
    }

    const tokens = await this.getOAuthTokens(serverId)
    const challenge = this.states.get(serverId)?.challenge
    const challengeUrl = extractAuthorizationServer(challenge)
    const registration =
      auth?.mode === 'oauth'
        ? auth.registration
        : tokens?.clientId
          ? { mode: 'static' as const, clientId: tokens.clientId }
          : { mode: 'dynamic' as const }
    const scopes = auth?.mode === 'oauth' ? auth.scopes : tokens?.scope?.split(/\s+/).filter(Boolean) ?? []
    let resource = auth?.mode === 'oauth' ? auth.resource : undefined

    const discovery = await this.discoverOAuthServer(challengeUrl ?? authorizationServer)
    resource = discovery.resource ?? resource ?? (auth?.mode !== 'oauth' ? server.url : undefined)
    const redirectUri = `${origin.replace(/\/+$/, '')}/admin/downstream-auth/callback`
    const codeVerifier = makeCodeVerifier()
    const state = randomBytes(16).toString('hex')
    let clientId: string
    let clientSecret: string | undefined
    let tokenEndpointAuthMethod: string | undefined

    if (registration.mode === 'dynamic') {
      if (!discovery.registrationEndpoint) {
        throw new Error(
          `Authorization server for ${serverId} does not expose registration_endpoint`
        )
      }
      await this.validateOAuthUrl(discovery.registrationEndpoint)
      const registration = await fetch(discovery.registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'MCP Session Gateway',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      })
      if (!registration.ok) {
        throw new Error(`Dynamic client registration failed with HTTP ${registration.status}`)
      }
      const body = (await registration.json()) as {
        client_id?: string
        client_secret?: string
        token_endpoint_auth_method?: string
      }
      if (!body.client_id) {
        throw new Error('Dynamic client registration response is missing client_id')
      }
      clientId = body.client_id
      clientSecret = normalizeToken(body.client_secret)
      tokenEndpointAuthMethod = normalizeTokenEndpointAuthMethod(
        normalizeToken(body.token_endpoint_auth_method),
        clientSecret
      )
    } else {
      clientId = registration.clientId
    }

    this.pendingOAuth.set(state, {
      serverId,
      state,
      codeVerifier,
      redirectUri,
      createdAt: Date.now(),
      clientId,
      clientSecret,
      tokenEndpointAuthMethod,
      resource,
    })

    const url = new URL(discovery.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', makeCodeChallenge(codeVerifier))
    url.searchParams.set('code_challenge_method', 'S256')
    if (scopes.length > 0) {
      url.searchParams.set('scope', scopes.join(' '))
    }
    if (resource) {
      url.searchParams.set('resource', resource)
    }

    this.states.set(serverId, {
      ...(this.states.get(serverId) ?? buildDefaultState(server)),
      status: DownstreamAuthStatus.Configured,
      authorizationServer: discovery.authorizationServer,
    })

    return { authorizeUrl: url.toString() }
  }

  async completeOAuth(
    state: string,
    code: string
  ): Promise<{ serverId: string; authorizationServer: string }> {
    this.pruneExpiredPendingOAuth()

    const pending = this.pendingOAuth.get(state)
    if (!pending || this.isPendingOAuthExpired(pending)) {
      if (pending) this.pendingOAuth.delete(state)
      throw new Error('OAuth state is invalid or expired')
    }
    this.pendingOAuth.delete(state)

    const server = this.getServer(pending.serverId)
    const auth = server.auth
    const authorizationServer = await this.getOAuthAuthorizationServer(server)
    if (!authorizationServer) {
      throw new Error(`Server ${pending.serverId} is not configured for OAuth`)
    }

    const discovery = await this.discoverOAuthServer(authorizationServer)
    let clientId = pending.clientId
    let clientSecret = pending.clientSecret
    let tokenEndpointAuthMethod = pending.tokenEndpointAuthMethod
    if (!clientId && auth?.mode === 'oauth' && auth.registration.mode === 'static') {
      clientId = auth.registration.clientId
    }

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
    })
    if (pending.resource) params.set('resource', pending.resource)
    const request = this.buildOAuthTokenRequest(
      { clientId, clientSecret, tokenEndpointAuthMethod },
      params
    )

    await this.validateOAuthUrl(discovery.tokenEndpoint)
    const response = await fetch(discovery.tokenEndpoint, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    })
    if (!response.ok) {
      throw new DownstreamAuthError(`OAuth token exchange failed with HTTP ${response.status}`, {
        serverId: server.id,
        kind: 'oauth_exchange_failed',
        status: response.status,
        authorizationServer,
      })
    }

    const body = (await response.json()) as Record<string, unknown>
    await this.storeOAuthTokens(server.id, {
      accessToken: String(body['access_token'] ?? ''),
      refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : undefined,
      expiresAt:
        typeof body['expires_in'] === 'number' ? Date.now() + body['expires_in'] * 1000 : undefined,
      tokenType: typeof body['token_type'] === 'string' ? body['token_type'] : 'Bearer',
      scope: typeof body['scope'] === 'string' ? body['scope'] : undefined,
      clientId,
      clientSecret,
      tokenEndpointAuthMethod,
      authorizationServer: discovery.authorizationServer,
      resource: pending.resource,
    })
    this.markAuthorized(server.id)
    return { serverId: server.id, authorizationServer: discovery.authorizationServer }
  }

  private async discoverOAuthServer(
    authorizationServer: string,
    visited: Set<string> = new Set()
  ): Promise<OAuthDiscovery> {
    if (visited.has(authorizationServer)) {
      throw new Error(`OAuth discovery loop detected for ${authorizationServer}`)
    }
    visited.add(authorizationServer)

    await this.validateOAuthFetchUrl(authorizationServer)

    const candidateUrls = [...new Set(buildDiscoveryUrls(authorizationServer))]
    let lastError: Error | undefined
    for (const candidateUrl of candidateUrls) {
      let response: Response | undefined
      try {
        response = await fetch(candidateUrl, {
          headers: { Accept: 'application/json' },
        })
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        continue
      }

      if (!response.ok) {
        lastError = new Error(`OAuth discovery failed for ${candidateUrl} with HTTP ${response.status}`)
        continue
      }

      let body: Record<string, unknown> | undefined
      try {
        body = (await response.json()) as Record<string, unknown>
      } catch {
        lastError = new Error(`OAuth discovery response from ${candidateUrl} is not valid JSON`)
        continue
      }

      const authorizationEndpoint = body['authorization_endpoint']
      const tokenEndpoint = body['token_endpoint']
      if (typeof authorizationEndpoint === 'string' && typeof tokenEndpoint === 'string') {
        return {
          authorizationEndpoint,
          tokenEndpoint,
          registrationEndpoint:
            typeof body['registration_endpoint'] === 'string'
              ? body['registration_endpoint']
              : undefined,
          authorizationServer,
          resource: typeof body['resource'] === 'string' ? body['resource'] : undefined,
        }
      }

      const authServers = extractOAuthAuthorizationServers(body)
      if (authServers.length === 0) {
        lastError = new Error(
          `OAuth discovery response from ${candidateUrl} is missing authorization_endpoint/token_endpoint or authorization_servers`
        )
        continue
      }

      for (const nextAuthorizationServer of authServers) {
        try {
          await this.validateOAuthUrl(nextAuthorizationServer)
          const discovery = await this.discoverOAuthServer(nextAuthorizationServer, visited)
          return {
            ...discovery,
            resource:
              typeof body['resource'] === 'string' && body['resource'].length > 0
                ? body['resource']
                : discovery.resource,
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
        }
      }
    }

    throw (
      lastError ??
      new Error(
        `OAuth discovery response is missing authorization_endpoint/token_endpoint or authorization_servers for ${authorizationServer}`
      )
    )
  }

  private async getOAuthTokens(serverId: string): Promise<OAuthTokenPayload | undefined> {
    const key = this.getEncryptionKey()
    if (!this.repo || !key) return undefined
    const stored = await this.repo.get(serverId, 'oauth_tokens')
    if (!stored) return undefined
    return decodeCiphertext<OAuthTokenPayload>(stored, key)
  }

  private async storeOAuthTokens(serverId: string, payload: OAuthTokenPayload): Promise<void> {
    const key = this.getEncryptionKey()
    if (!this.repo || !key) {
      throw new Error(
        'Managed downstream secrets require SQLite and DOWNSTREAM_AUTH_ENCRYPTION_KEY'
      )
    }
    const encrypted = encodeCiphertext(payload, key)
    await this.repo.save({
      serverId,
      kind: 'oauth_tokens',
      ...encrypted,
      updatedAt: Date.now(),
    })
  }

  private async ensureFreshOAuthTokens(
    server: DownstreamServer,
    tokens: OAuthTokenPayload
  ): Promise<OAuthTokenPayload> {
    if (!tokens.expiresAt || tokens.expiresAt - Date.now() > 60_000) {
      return tokens
    }

    if (!tokens.refreshToken) {
      this.states.set(server.id, {
        ...(this.states.get(server.id) ?? buildDefaultState(server)),
        status: DownstreamAuthStatus.AuthRequired,
        message: 'OAuth access token expired and no refresh token is available',
      })
      throw new DownstreamAuthError(`[registry/http] OAuth token expired for ${server.id}`, {
        serverId: server.id,
        kind: 'token_expired',
      })
    }

    try {
      const authorizationServer =
        tokens.authorizationServer ??
        (server.auth?.mode === 'oauth' ? server.auth.authorizationServer : undefined)
      if (!authorizationServer) {
        throw new Error('OAuth authorization server is unknown')
      }
      const discovery = await this.discoverOAuthServer(authorizationServer)
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      })
      if (tokens.resource) params.set('resource', tokens.resource)
      const request = this.buildOAuthTokenRequest(
        {
          clientId: tokens.clientId,
          clientSecret: tokens.clientSecret,
          tokenEndpointAuthMethod: tokens.tokenEndpointAuthMethod,
        },
        params
      )
      await this.validateOAuthUrl(discovery.tokenEndpoint)
      const response = await fetch(discovery.tokenEndpoint, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const body = (await response.json()) as Record<string, unknown>
      const refreshed: OAuthTokenPayload = {
        accessToken: String(body['access_token'] ?? ''),
        refreshToken:
          typeof body['refresh_token'] === 'string' ? body['refresh_token'] : tokens.refreshToken,
        expiresAt:
          typeof body['expires_in'] === 'number'
            ? Date.now() + body['expires_in'] * 1000
            : tokens.expiresAt,
        tokenType:
          typeof body['token_type'] === 'string'
            ? body['token_type']
            : (tokens.tokenType ?? 'Bearer'),
        scope: typeof body['scope'] === 'string' ? body['scope'] : tokens.scope,
        clientId: tokens.clientId,
        clientSecret: tokens.clientSecret,
        tokenEndpointAuthMethod: tokens.tokenEndpointAuthMethod,
        authorizationServer,
        resource: tokens.resource,
      }
      await this.storeOAuthTokens(server.id, refreshed)
      this.markAuthorized(server.id)
      return refreshed
    } catch (error) {
      this.states.set(server.id, {
        ...(this.states.get(server.id) ?? buildDefaultState(server)),
        status: DownstreamAuthStatus.RefreshFailed,
        message: error instanceof Error ? error.message : String(error),
      })
      throw new DownstreamAuthError(`[registry/http] OAuth token refresh failed for ${server.id}`, {
        serverId: server.id,
        kind: 'invalid_token',
      })
    }
  }
}
