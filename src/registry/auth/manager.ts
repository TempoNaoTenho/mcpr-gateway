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
  authorizationServer?: string
}

type OAuthPendingState = {
  serverId: string
  state: string
  codeVerifier: string
  redirectUri: string
  createdAt: number
}

type AuthStateInternal = DownstreamAuthState

type OAuthDiscovery = {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
}

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

function buildDiscoveryUrl(authorizationServer: string): string {
  if (authorizationServer.includes('/.well-known/')) return authorizationServer
  return `${authorizationServer.replace(/\/+$/, '')}/.well-known/openid-configuration`
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
      return {}
    }

    if (auth.mode === 'none') return {}

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
    const server = this.getServer(serverId)
    if (server.auth?.mode !== 'oauth') {
      throw new Error(`Server ${serverId} is not configured for OAuth`)
    }

    const authorizationServer =
      server.auth.authorizationServer ?? this.states.get(serverId)?.authorizationServer
    if (!authorizationServer) {
      throw new Error(
        `OAuth authorization server is unknown for ${serverId}; refresh once to capture a 401 challenge or configure authorizationServer explicitly`
      )
    }

    const discovery = await this.discoverOAuthServer(authorizationServer)
    const redirectUri = `${origin.replace(/\/+$/, '')}/admin/downstream-auth/callback`
    const codeVerifier = makeCodeVerifier()
    const state = randomBytes(16).toString('hex')
    let clientId: string

    if (server.auth.registration.mode === 'dynamic') {
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
      const body = (await registration.json()) as { client_id?: string }
      if (!body.client_id) {
        throw new Error('Dynamic client registration response is missing client_id')
      }
      clientId = body.client_id
    } else {
      clientId = server.auth.registration.clientId
    }

    this.pendingOAuth.set(state, {
      serverId,
      state,
      codeVerifier,
      redirectUri,
      createdAt: Date.now(),
    })

    const url = new URL(discovery.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', makeCodeChallenge(codeVerifier))
    url.searchParams.set('code_challenge_method', 'S256')
    if (server.auth.scopes.length > 0) {
      url.searchParams.set('scope', server.auth.scopes.join(' '))
    }
    if (server.auth.resource) {
      url.searchParams.set('resource', server.auth.resource)
    }

    this.states.set(serverId, {
      ...(this.states.get(serverId) ?? buildDefaultState(server)),
      status: DownstreamAuthStatus.Configured,
      authorizationServer,
    })

    return { authorizeUrl: url.toString() }
  }

  async completeOAuth(state: string, code: string): Promise<{ serverId: string }> {
    const pending = this.pendingOAuth.get(state)
    if (!pending) {
      throw new Error('OAuth state is invalid or expired')
    }
    this.pendingOAuth.delete(state)

    const server = this.getServer(pending.serverId)
    if (server.auth?.mode !== 'oauth') {
      throw new Error(`Server ${pending.serverId} is not configured for OAuth`)
    }

    const authorizationServer =
      server.auth.authorizationServer ?? this.states.get(server.id)?.authorizationServer
    if (!authorizationServer) {
      throw new Error(`OAuth authorization server is unknown for ${server.id}`)
    }

    const discovery = await this.discoverOAuthServer(authorizationServer)
    const clientId =
      server.auth.registration.mode === 'static' ? server.auth.registration.clientId : undefined

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
    })
    if (clientId) params.set('client_id', clientId)

    await this.validateOAuthUrl(discovery.tokenEndpoint)
    const response = await fetch(discovery.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
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
      authorizationServer,
    })
    this.markAuthorized(server.id)
    return { serverId: server.id }
  }

  private async discoverOAuthServer(authorizationServer: string): Promise<OAuthDiscovery> {
    await this.validateOAuthUrl(authorizationServer)
    const response = await fetch(buildDiscoveryUrl(authorizationServer), {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(`OAuth discovery failed with HTTP ${response.status}`)
    }
    const body = (await response.json()) as Record<string, unknown>
    const authorizationEndpoint = body['authorization_endpoint']
    const tokenEndpoint = body['token_endpoint']
    if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
      throw new Error(
        'OAuth discovery response is missing authorization_endpoint or token_endpoint'
      )
    }
    return {
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint:
        typeof body['registration_endpoint'] === 'string'
          ? body['registration_endpoint']
          : undefined,
    }
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
      if (tokens.clientId) params.set('client_id', tokens.clientId)
      await this.validateOAuthUrl(discovery.tokenEndpoint)
      const response = await fetch(discovery.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
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
        authorizationServer,
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
