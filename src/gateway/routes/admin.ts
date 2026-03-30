import { nanoid } from 'nanoid'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { GatewayErrorCode } from '../../types/errors.js'
import { logErrorInternal, isProductionMode } from '../../utils/error-sanitize.js'
import type { IAuditRepository, AuditQueryFilters } from '../../repositories/audit/interface.js'
import type { IConfigRepository } from '../../repositories/config/interface.js'
import type { ISessionStore } from '../../types/interfaces.js'
import { SessionIdSchema } from '../../types/identity.js'
import type { DownstreamRegistry } from '../../registry/registry.js'
import { AuthConfigSchema, GatewayConfigFileSchema } from '../../config/schemas.js'
import {
  mergeWithAdminConfig,
  toAdminConfig,
  validateGatewayConfig,
  type AdminConfig,
} from '../../config/loader.js'
import { AuditEventType, GatewayMode, Mode, SessionStatus } from '../../types/enums.js'
import type { RuntimeConfigManager } from '../../config/runtime.js'
import {
  DownstreamServerSchema,
  supportsStdioInteractiveAuth,
  type DownstreamServer,
} from '../../types/server.js'
import { coerceMcpImport } from '../../lib/mcp-import-parse.js'
import { splitCommandLine } from '../../lib/command-line.js'
import {
  buildAdminToolEntry,
  estimateSerializedTokens,
  summarizeClientToolWindow,
  summarizeToolEntries,
} from '../../admin/catalog.js'
import { getConfig } from '../../config/index.js'
import { getStaticKeysForAuth } from '../../auth/oauth-config.js'
import { disabledToolKeysForNamespace } from '../../config/disabled-tool-keys.js'
import { generateToolcards } from '../../toolcard/index.js'
import { buildVisibleToolCatalog } from '../../session/catalog.js'
import { applyInstructionsPlaceholders, buildGatewayInstructions } from '../dispatch/initialize.js'
import { buildGatewayToolWindowForMode } from '../discovery.js'
import { toolCandidateKey } from '../../candidate/lexical.js'
import { downstreamAuthManager } from '../../registry/auth/index.js'
import { DownstreamAuthStatus } from '../../types/enums.js'
import { StdioInteractiveAuthStatus } from '../../types/enums.js'
import {
  authCookieHeaders,
  clearAuthCookieHeaders,
  createAdminSession,
  getGatewayAdminPassword,
  getGatewayAdminUser,
  revokeAdminSession,
  sessionFromCookies,
  validateAdminCredentials,
} from '../admin-auth-session.js'
import { getRequestOrigin } from '../request-origin.js'

interface AdminRouteOptions {
  auditRepo?: IAuditRepository
  configRepo?: IConfigRepository
  configManager?: RuntimeConfigManager
  sessionStore?: ISessionStore
  registry?: DownstreamRegistry
}

type ImportValidationError = {
  id: string
  field: string
  message: string
}

type ImportConflict = {
  id: string
  message: string
}

type ImportPreview = {
  normalizedServers: DownstreamServer[]
  conflicts: ImportConflict[]
  validationErrors: ImportValidationError[]
  namespacesToCreate: string[]
}

type ImportRuntimeWarning = {
  id: string
  message: string
}

type ServerRefreshPayload = {
  toolCount: number
  health: string
  lastChecked?: string
  latencyMs?: number
  error?: string
  authStatus?: string
  authMessage?: string
  authAuthorizationServer?: string
  interactiveAuthStatus?: string
  interactiveAuthMessage?: string
  interactiveAuthUrl?: string
}

type AdminConfigValidationIssue = {
  field: string
  message: string
}

class AdminConfigValidationError extends Error {
  constructor(
    message: string,
    readonly issues: AdminConfigValidationIssue[]
  ) {
    super(message)
    this.name = 'AdminConfigValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function inferInboundOAuthPublicBaseUrl(
  requested: unknown,
  requestOrigin: string
): Record<string, unknown> | undefined {
  if (!isRecord(requested) || typeof requested['mode'] !== 'string') {
    return undefined
  }

  if (requested['mode'] !== 'oauth' && requested['mode'] !== 'hybrid') {
    return requested
  }

  const oauth = isRecord(requested['oauth']) ? requested['oauth'] : {}
  const publicBaseUrl = trimToUndefined(oauth['publicBaseUrl']) ?? requestOrigin

  return {
    ...requested,
    oauth: {
      ...oauth,
      publicBaseUrl,
    },
  }
}

function redactServerSecrets(server: DownstreamServer): DownstreamServer {
  if (!server.auth) return server

  if (server.auth.mode === 'bearer' && server.auth.source.type === 'literal') {
    return {
      ...server,
      auth: {
        ...server.auth,
        source: {
          type: 'literal',
          value: '***',
        },
      },
    }
  }

  return server
}

function createDefaultNamespacePolicy(roleNames: string[]) {
  return {
    allowedRoles: roleNames,
    bootstrapWindowSize: 4,
    candidatePoolSize: 16,
    allowedModes: [Mode.Read, Mode.Write],
    gatewayMode: GatewayMode.Code,
    telemetryEnabled: false,
    disabledTools: [] as { serverId: string; name: string }[],
    description: '',
    customInstructions: {} as { compat?: string; code?: string },
  }
}

function normalizeStringList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function extractImportedNamespaces(
  raw: Record<string, unknown>,
  defaultNamespace?: string
): string[] {
  const explicitNamespaces = Array.isArray(raw['namespaces'])
    ? raw['namespaces']
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    : []

  if (explicitNamespaces.length > 0) {
    return [...new Set(explicitNamespaces)]
  }

  const explicitNamespace = trimToUndefined(raw['namespace'])
  if (explicitNamespace) {
    return [explicitNamespace]
  }

  if (defaultNamespace) {
    const list = normalizeStringList(defaultNamespace.split(','))
    if (list.length > 0) {
      return list
    }
  }

  throw new Error('namespace is required when defaultNamespace is not provided')
}

function normalizeAdminConfigNamespaces(config: AdminConfig): AdminConfig {
  const roleNames = Object.keys(config.roles)
  const namespaces = { ...config.namespaces }
  const roles = Object.fromEntries(
    Object.entries(config.roles).map(([role, policy]) => [
      role,
      {
        ...policy,
        allowNamespaces: [...policy.allowNamespaces],
      },
    ])
  )
  const knownNamespaces = new Set(Object.keys(namespaces))

  for (const server of config.servers) {
    for (const ns of server.namespaces) {
      if (knownNamespaces.has(ns)) continue

      namespaces[ns] = createDefaultNamespacePolicy(roleNames)
      knownNamespaces.add(ns)

      for (const policy of Object.values(roles)) {
        if (!policy.allowNamespaces.includes(ns)) {
          policy.allowNamespaces.push(ns)
        }
      }
    }
  }

  return {
    ...config,
    namespaces,
    roles,
  }
}

function normalizeAdminAccessGraph(config: AdminConfig): AdminConfig {
  const knownRoles = new Set(Object.keys(config.roles))

  const namespaces = Object.fromEntries(
    Object.entries(config.namespaces).map(([namespace, policy]) => {
      const allowedRoles = normalizeStringList(policy.allowedRoles)
      const validRoles = allowedRoles.filter((role) => knownRoles.has(role))

      return [
        namespace,
        {
          ...policy,
          allowedRoles: validRoles,
        },
      ]
    })
  )

  const auth = config.auth
  if (auth.mode === 'oauth') {
    return { ...config, namespaces, auth }
  }

  const rawStatic = getStaticKeysForAuth(auth)
  const staticKeys = rawStatic
    ? Object.fromEntries(
        Object.entries(rawStatic).map(([token, entry]) => {
          const roles = normalizeStringList(entry.roles)
          const validRoles = roles.filter((role) => knownRoles.has(role))

          return [
            token,
            {
              ...entry,
              roles: validRoles,
            },
          ]
        })
      )
    : undefined

  if (auth.mode === 'static_key') {
    return {
      ...config,
      namespaces,
      auth: { mode: 'static_key', staticKeys },
    }
  }

  return {
    ...config,
    namespaces,
    auth: {
      mode: 'hybrid',
      oauth: auth.oauth,
      staticKeys,
    },
  }
}

export type DeleteNamespaceFromAdminResult =
  | { ok: true; config: AdminConfig }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'servers_would_be_orphaned'; serverIds: string[] }

export function deleteNamespaceFromAdminConfig(
  current: AdminConfig,
  namespace: string
): DeleteNamespaceFromAdminResult {
  if (!current.namespaces[namespace]) {
    return { ok: false, error: 'not_found' }
  }

  const strippedServers = current.servers.map((server) => ({
    ...server,
    namespaces: server.namespaces.filter((ns) => ns !== namespace),
  }))
  const orphanedIds = strippedServers
    .filter((server) => server.namespaces.length === 0)
    .map((server) => server.id)
  if (orphanedIds.length > 0) {
    return { ok: false, error: 'servers_would_be_orphaned', serverIds: orphanedIds }
  }

  const { [namespace]: _removedNs, ...restNamespaces } = current.namespaces
  const { [namespace]: _removedSp, ...restStarterPacks } = current.starterPacks

  const roles = Object.fromEntries(
    Object.entries(current.roles).map(([roleKey, policy]) => [
      roleKey,
      {
        ...policy,
        allowNamespaces: policy.allowNamespaces.filter((ns) => ns !== namespace),
      },
    ])
  )

  return {
    ok: true,
    config: {
      ...current,
      namespaces: restNamespaces,
      starterPacks: restStarterPacks,
      servers: strippedServers,
      roles,
    },
  }
}

export type CreateNamespaceResult =
  | { ok: true; config: AdminConfig }
  | { ok: false; error: 'already_exists' }
  | { ok: false; error: 'invalid_name' }

export function createNamespaceInAdminConfig(
  current: AdminConfig,
  namespace: string,
  description?: string
): CreateNamespaceResult {
  if (!/^[a-z][a-z0-9_-]*$/.test(namespace)) {
    return { ok: false, error: 'invalid_name' }
  }

  if (current.namespaces[namespace]) {
    return { ok: false, error: 'already_exists' }
  }

  const roleNames = Object.keys(current.roles)
  const newNamespacePolicy = createDefaultNamespacePolicy(roleNames)
  if (description !== undefined) {
    newNamespacePolicy.description = description
  }

  const roles = Object.fromEntries(
    Object.entries(current.roles).map(([roleKey, policy]) => [
      roleKey,
      {
        ...policy,
        allowNamespaces: [...policy.allowNamespaces, namespace],
      },
    ])
  )

  return {
    ok: true,
    config: {
      ...current,
      namespaces: {
        ...current.namespaces,
        [namespace]: newNamespacePolicy,
      },
      roles,
    },
  }
}

function buildAuthSummary(effectiveAuth: {
  mode: string
  staticKeys?: Record<string, { userId: string; roles: string[] }>
  oauth?: { publicBaseUrl?: string }
}) {
  const clientAuth =
    effectiveAuth.mode === 'oauth'
      ? ('oauth' as const)
      : effectiveAuth.mode === 'hybrid'
        ? ('hybrid' as const)
        : ('bearer_tokens' as const)
  return {
    clientAuth,
    clientTokensConfigured: Object.keys(effectiveAuth.staticKeys ?? {}).length,
    oauthPublicBaseUrl:
      effectiveAuth.mode === 'oauth' || effectiveAuth.mode === 'hybrid'
        ? effectiveAuth.oauth?.publicBaseUrl
        : undefined,
    adminTokenConfigured: Boolean(process.env['ADMIN_TOKEN']),
  }
}

function mergeInboundAuthPolicy(
  current: AdminConfig['auth'],
  requested: unknown,
  requestOrigin?: string
): AdminConfig['auth'] {
  const normalizedRequested =
    requestOrigin !== undefined
      ? inferInboundOAuthPublicBaseUrl(requested, requestOrigin)
      : requested

  if (!isRecord(normalizedRequested) || typeof normalizedRequested['mode'] !== 'string') {
    return current
  }

  const currentStaticKeys = getStaticKeysForAuth(current)
  const hasStaticKeys = Boolean(currentStaticKeys && Object.keys(currentStaticKeys).length > 0)

  if (normalizedRequested['mode'] === 'static_key') {
    return {
      mode: 'static_key',
      staticKeys: currentStaticKeys,
    }
  }

  if (normalizedRequested['mode'] === 'oauth') {
    const parsed = AuthConfigSchema.parse(normalizedRequested)
    if (parsed.mode !== 'oauth') return current
    if (hasStaticKeys) {
      return {
        mode: 'hybrid',
        oauth: parsed.oauth,
        staticKeys: currentStaticKeys,
      }
    }
    return parsed
  }

  if (normalizedRequested['mode'] === 'hybrid') {
    const parsed = AuthConfigSchema.parse(normalizedRequested)
    if (parsed.mode !== 'hybrid') return current
    return {
      mode: 'hybrid',
      oauth: parsed.oauth,
      staticKeys: currentStaticKeys,
    }
  }

  return current
}

function validateDownstreamAuthCapabilities(
  server: DownstreamServer
): AdminConfigValidationIssue[] {
  const issues: AdminConfigValidationIssue[] = []
  const capabilities = downstreamAuthManager.getCapabilities()

  if (
    server.auth?.mode === 'bearer' &&
    server.auth.source.type === 'secret' &&
    !capabilities.managedSecretsEnabled
  ) {
    issues.push({
      field: `servers.${server.id}.auth.source.type`,
      message: 'Managed bearer secrets require SQLite and DOWNSTREAM_AUTH_ENCRYPTION_KEY',
    })
  }

  return issues
}

function buildValidatedAdminConfig(
  configManager: RuntimeConfigManager,
  next: unknown
): AdminConfig {
  const nextRecord =
    next && typeof next === 'object' && !Array.isArray(next)
      ? (next as Record<string, unknown>)
      : {}
  const nextAuth = isRecord(nextRecord['auth']) ? nextRecord['auth'] : {}
  const effectiveAuth = configManager.getEffective().auth
  const parsed = GatewayConfigFileSchema.parse({
    ...nextRecord,
    auth: AuthConfigSchema.parse({
      ...(effectiveAuth as Record<string, unknown>),
      ...(nextAuth as Record<string, unknown>),
    }),
  })
  const merged = mergeWithAdminConfig(configManager.getBootstrap(), {
    ...configManager.getAdminConfig(),
    ...parsed,
  })
  const normalized = normalizeAdminAccessGraph(
    normalizeAdminConfigNamespaces(toAdminConfig(merged))
  )
  const capabilityIssues = normalized.servers.flatMap((server) =>
    validateDownstreamAuthCapabilities(server)
  )
  if (capabilityIssues.length > 0) {
    throw new AdminConfigValidationError('Invalid downstream auth configuration', capabilityIssues)
  }
  return toAdminConfig(
    validateGatewayConfig(mergeWithAdminConfig(configManager.getBootstrap(), normalized))
  )
}

function zodIssuesToAdminIssues(err: ZodError): AdminConfigValidationIssue[] {
  return err.issues.map((issue) => ({
    field: issuePathToField(issue.path),
    message: issue.message,
  }))
}

function issuePathToField(path: (string | number)[]): string {
  if (path.length === 0) return 'root'
  return path.map((part) => String(part)).join('.')
}

function collectImportErrors(id: string, err: unknown): ImportValidationError[] {
  if (err instanceof ZodError) {
    return err.issues.map((issue) => ({
      id,
      field: issuePathToField(issue.path),
      message: issue.message,
    }))
  }

  return [
    {
      id,
      field: 'root',
      message: err instanceof Error ? err.message : String(err),
    },
  ]
}

function normalizeImportedServer(
  id: string,
  raw: unknown,
  defaultNamespace?: string
): DownstreamServer {
  if (!isRecord(raw)) {
    throw new Error('server config must be an object')
  }

  const namespaces = extractImportedNamespaces(raw, defaultNamespace)

  const explicitTransport = trimToUndefined(raw['transport'])
  const commandLine = trimToUndefined(raw['command'])
  const hasCommand = commandLine !== undefined
  const hasUrl = trimToUndefined(raw['url']) !== undefined

  let transport: 'stdio' | 'http' | 'streamable-http'
  if (hasCommand) {
    transport = 'stdio'
  } else if (hasUrl) {
    transport = explicitTransport === 'http' ? 'http' : 'streamable-http'
  } else if (
    explicitTransport === 'stdio' ||
    explicitTransport === 'http' ||
    explicitTransport === 'streamable-http'
  ) {
    transport = explicitTransport
  } else {
    throw new Error('server must include either `command` or `url`')
  }

  let command = commandLine
  let args = raw['args']
  if (hasCommand && args === undefined && commandLine) {
    const parts = splitCommandLine(commandLine)
    if (parts.length === 0) {
      throw new Error('`command` must include an executable')
    }
    command = parts[0]
    args = parts.slice(1)
  }

  const candidate: Record<string, unknown> = {
    id,
    namespaces,
    transport,
    url: trimToUndefined(raw['url']),
    command,
    args,
    env: raw['env'],
    stdioTimeoutSeconds: raw['stdioTimeoutSeconds'],
    stdioInteractiveAuth: raw['stdioInteractiveAuth'],
    headers: raw['headers'],
    auth: raw['auth'],
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : true,
    trustLevel: raw['trustLevel'] ?? 'verified',
    refreshIntervalSeconds: raw['refreshIntervalSeconds'],
    healthcheck: raw['healthcheck'] ?? {
      enabled: true,
      intervalSeconds: 30,
    },
    discovery: raw['discovery'],
  }

  return DownstreamServerSchema.parse(candidate)
}

async function collectImportRuntimeWarnings(
  registry: DownstreamRegistry | undefined,
  servers: DownstreamServer[]
): Promise<ImportRuntimeWarning[]> {
  if (!registry || servers.length === 0) return []

  const warnings: ImportRuntimeWarning[] = []
  const refreshableServers = servers.filter((server) => {
    if (server.transport === 'stdio') {
      warnings.push({
        id: server.id,
        message: 'Saved without runtime validation. Refresh manually after env is ready.',
      })
      return false
    }
    return true
  })

  if (refreshableServers.length === 0) return warnings

  const results = await Promise.allSettled(
    refreshableServers.map(async (server) => {
      await registry.refreshTools(server.id)
      return null
    })
  )

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result?.status === 'rejected') {
      warnings.push({
        id: refreshableServers[i]!.id,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
    }
  }

  return warnings
}

function buildInteractiveAuthPayload(
  registry: DownstreamRegistry,
  server: DownstreamServer
): Pick<
  ServerRefreshPayload,
  'interactiveAuthStatus' | 'interactiveAuthMessage' | 'interactiveAuthUrl'
> {
  if (!supportsStdioInteractiveAuth(server)) {
    return {}
  }

  const state = registry.getStdioInteractiveAuthState(server.id)
  if (state.status === StdioInteractiveAuthStatus.Idle) {
    return {}
  }

  return {
    interactiveAuthStatus: state.status,
    interactiveAuthMessage: state.message,
    interactiveAuthUrl: state.url,
  }
}

function buildRefreshPayload(
  registry: DownstreamRegistry,
  server: DownstreamServer,
  toolCount: number,
  authState?: {
    status?: string
    message?: string
    authorizationServer?: string
  },
  healthState?: {
    status: string
    lastChecked?: string
    latencyMs?: number
    error?: string
  }
): ServerRefreshPayload {
  return {
    toolCount,
    health: healthState?.status ?? 'unknown',
    lastChecked: healthState?.lastChecked,
    latencyMs: healthState?.latencyMs,
    error: healthState?.error,
    authStatus: authState?.status,
    authMessage: authState?.message,
    authAuthorizationServer: authState?.authorizationServer,
    ...buildInteractiveAuthPayload(registry, server),
  }
}

async function buildToolsForServer(
  registry: DownstreamRegistry,
  server: DownstreamServer,
  namespace?: string
) {
  const records = namespace
    ? (registry.getToolsByNamespace(namespace).find((group) => group.server.id === server.id)
        ?.records ?? [])
    : await registry.getTools(server.id)

  return records.map((record) => buildAdminToolEntry(server, record))
}

function buildImportPreview(current: AdminConfig, body: unknown): ImportPreview {
  const coerced = coerceMcpImport(body)
  const existingIds = new Set(current.servers.map((server) => server.id))
  const normalizedServers: DownstreamServer[] = []
  const conflicts: ImportConflict[] = []
  const validationErrors: ImportValidationError[] = []

  if (!coerced.ok) {
    return {
      normalizedServers,
      conflicts,
      validationErrors: [
        {
          id: 'import',
          field: 'root',
          message: coerced.message,
        },
      ],
      namespacesToCreate: [],
    }
  }

  const { mcpServers, defaultNamespace } = coerced

  for (const [id, raw] of Object.entries(mcpServers)) {
    if (existingIds.has(id)) {
      conflicts.push({
        id,
        message: `server "${id}" already exists`,
      })
      continue
    }

    try {
      normalizedServers.push(normalizeImportedServer(id, raw, defaultNamespace))
    } catch (err) {
      validationErrors.push(...collectImportErrors(id, err))
    }
  }

  const existingNamespaces = new Set(Object.keys(current.namespaces))
  const namespacesToCreate = [
    ...new Set(
      normalizedServers
        .flatMap((server) => server.namespaces)
        .filter((namespace) => !existingNamespaces.has(namespace))
    ),
  ].sort()

  return {
    normalizedServers,
    conflicts,
    validationErrors,
    namespacesToCreate,
  }
}

// ── Auth middleware ────────────────────────────────────────────────────────────

/**
 * For the UI routes (`/admin/auth/*`): no pre-authentication required.
 * For all other `/admin/*` routes: require a valid `admin_session` cookie
 * from `POST /admin/auth/login` (username / password).
 */
function requireAdminAuth(app: FastifyInstance): void {
  const adminToken = process.env['ADMIN_TOKEN']
  if (!adminToken) return

  app.addHook('preHandler', async (request, reply) => {
    // Skip the auth endpoints themselves
    if (request.url.startsWith('/admin/auth/')) return
    if (request.url.startsWith('/admin/downstream-auth/callback')) return

    // Check HttpOnly cookie session
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cookies = (request as any).cookies as Record<string, string> | undefined
    if (sessionFromCookies(cookies)) return

    return reply.status(401).send({ error: 'Unauthorized' })
  })
}

function getGatewayListenInfo(app: FastifyInstance): {
  listenHost: string
  listenPort: number
  listenSource: 'bound' | 'env'
} {
  try {
    const addr = app.server.address()
    if (addr && typeof addr === 'object' && 'port' in addr && addr.port != null) {
      return {
        listenHost: String(addr.address),
        listenPort: addr.port,
        listenSource: 'bound',
      }
    }
  } catch {
    /* not listening (e.g. tests with inject only) */
  }
  return {
    listenHost: process.env['HOST'] ?? '127.0.0.1',
    listenPort: Number(process.env['PORT'] ?? 3000),
    listenSource: 'env',
  }
}

export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOptions): Promise<void> {
  // Register rate limiting plugin (disabled globally, enabled per-route via config)
  await app.register(rateLimit, {
    global: false,
  })

  requireAdminAuth(app)

  const production = isProductionMode()

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AdminConfigValidationError) {
      logErrorInternal(err, (e) => _request.log.error(e))
      return reply.status(400).send({
        error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
        message: err.message,
        ...(production ? {} : { issues: err.issues }),
      })
    }

    if (err instanceof ZodError) {
      logErrorInternal(err, (e) => _request.log.error(e))
      return reply.status(400).send({
        error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
        message: 'Invalid admin config payload',
        ...(production ? {} : { issues: zodIssuesToAdminIssues(err) }),
      })
    }

    throw err
  })

  // ── Auth endpoints ────────────────────────────────────────────────────────

  app.get('/admin/auth/config', async (_request, reply) => {
    return reply.send({
      username: getGatewayAdminUser(),
      passwordRequired: Boolean(process.env['ADMIN_TOKEN']),
    })
  })

  app.post(
    '/admin/auth/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minute',
          keyGenerator: (request) => request.ip,
          errorResponseBuilder: (_request, context) => {
            const err = new Error('RATE_LIMIT_EXCEEDED') as Error & {
              statusCode: number
              rateLimitRetryAfter: string
            }
            err.statusCode = 429
            err.rateLimitRetryAfter = context.after
            return err
          },
        },
      },
    },
    async (request, reply) => {
      const adminToken = process.env['ADMIN_TOKEN']
      if (!adminToken) {
        // No token configured → auto-login (guarded by debug mode at registration)
        return reply.send({ authenticated: true })
      }

      const body = request.body as { username?: string; password?: string } | undefined

      const username = body?.username?.trim()
      const password = (body?.password ?? '').trim()

      if (!getGatewayAdminPassword()) {
        return reply.status(503).send({ error: 'Admin authentication is misconfigured' })
      }

      if (!validateAdminCredentials(username, password)) {
        return reply.status(401).send({ error: 'Invalid credentials' })
      }

      const sessionId = createAdminSession()

      const isProduction = process.env['NODE_ENV'] === 'production'
      reply.headers({
        'Set-Cookie': authCookieHeaders(sessionId, isProduction),
      })

      return reply.send({ authenticated: true })
    }
  )

  app.post('/admin/auth/logout', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cookies = (request as any).cookies as Record<string, string> | undefined
    revokeAdminSession(sessionFromCookies(cookies))

    const isProduction = process.env['NODE_ENV'] === 'production'
    reply.headers({
      'Set-Cookie': clearAuthCookieHeaders(isProduction),
    })
    return reply.send({ authenticated: false })
  })

  app.get('/admin/auth/me', async (request, reply) => {
    const adminToken = process.env['ADMIN_TOKEN']
    if (!adminToken) return reply.send({ authenticated: true })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cookies = (request as any).cookies as Record<string, string> | undefined
    const authenticated = Boolean(sessionFromCookies(cookies))
    return reply.send({ authenticated })
  })

  // ── Dashboard ─────────────────────────────────────────────────────────────

  app.get('/admin/dashboard', async (_request, reply) => {
    const [sessions, servers] = await Promise.all([
      opts.sessionStore?.list() ?? Promise.resolve([]),
      opts.registry?.listServers() ?? Promise.resolve([]),
    ])

    const activeSessions = sessions.filter((s) => s.status === 'active').length
    const healthStates = opts.registry?.getHealthStates() ?? {}

    let healthy = 0,
      degraded = 0,
      offline = 0
    for (const status of Object.values(healthStates)) {
      if (status === 'healthy') healthy++
      else if (status === 'degraded') degraded++
      else if (status === 'offline') offline++
    }

    // Total tools across all servers
    let totalTools = 0
    for (const server of servers) {
      const tools = (await opts.registry?.getTools(server.id)) ?? []
      totalTools += tools.length
    }

    // Recent audit events (last 5)
    let recentEvents: unknown[] = []
    if (opts.auditRepo) {
      const result = await opts.auditRepo.query({ limit: 5, offset: 0 })
      recentEvents = result.events
    }

    // Error rate last 1h: ratio of execution_denied events to tool_executed events
    let errorRate1h = 0
    if (opts.auditRepo) {
      const oneHourAgo = new Date(Date.now() - 3_600_000)
      const [denied, executed] = await Promise.all([
        opts.auditRepo.query({
          eventType: AuditEventType.ExecutionDenied,
          from: oneHourAgo,
          limit: 1,
          offset: 0,
        }),
        opts.auditRepo.query({
          eventType: AuditEventType.ToolExecuted,
          from: oneHourAgo,
          limit: 1,
          offset: 0,
        }),
      ])
      const total = (denied.total ?? 0) + (executed.total ?? 0)
      errorRate1h = total > 0 ? (denied.total ?? 0) / total : 0
    }

    return reply.send({
      sessions: { active: activeSessions, total: sessions.length },
      servers: { total: servers.length, healthy, degraded, offline },
      tools: { total: totalTools, quarantined: 0 },
      recentEvents,
      errorRate1h,
      gateway: getGatewayListenInfo(app),
    })
  })

  // ── Sessions ──────────────────────────────────────────────────────────────

  if (opts.sessionStore) {
    const store = opts.sessionStore

    app.get('/admin/sessions', async (request, reply) => {
      const q = request.query as Record<string, string | undefined>
      const namespace = q['namespace']
      const status = q['status']
      const limit = q['limit'] ? Number(q['limit']) : 50
      const offset = q['offset'] ? Number(q['offset']) : 0

      let sessions = await store.list(namespace)
      if (status) sessions = sessions.filter((s) => s.status === status)

      const total = sessions.length
      const page = sessions.slice(offset, offset + limit)
      return reply.send({ sessions: page, total })
    })

    app.get<{ Params: { id: string } }>('/admin/sessions/:id', async (request, reply) => {
      const sessionId = SessionIdSchema.parse(request.params.id)
      const session = await store.get(sessionId)
      if (!session) return reply.status(404).send({ error: 'Session not found' })
      return reply.send(session)
    })

    app.delete<{ Params: { id: string } }>('/admin/sessions/:id', async (request, reply) => {
      const sessionId = SessionIdSchema.parse(request.params.id)
      const session = await store.get(sessionId)
      if (!session) return reply.status(404).send({ error: 'Session not found' })
      await store.set(sessionId, { ...session, status: SessionStatus.Revoked })
      return reply.send({ revoked: true })
    })
  }

  // ── Servers ───────────────────────────────────────────────────────────────

  if (opts.registry) {
    const registry = opts.registry

    app.get('/admin/servers', async (_request, reply) => {
      const servers = await registry.listServers()

      const result = await Promise.all(
        servers.map(async (server) => {
          const tools = await buildToolsForServer(registry, server)
          const summary = summarizeToolEntries(tools)
          const healthState = registry.getHealthState(server.id)
          const authState =
            server.transport === 'stdio'
              ? undefined
              : await downstreamAuthManager.getState(server.id)
          return {
            id: server.id,
            namespaces: server.namespaces,
            transport: server.transport,
            stdioInteractiveAuth: server.stdioInteractiveAuth,
            url: server.url,
            command: server.command,
            enabled: server.enabled,
            trustLevel: server.trustLevel,
            health: healthState?.status ?? 'unknown',
            toolCount: tools.length,
            schemaTokens: summary.schemaTokens,
            totalTokens: summary.totalTokens,
            customizedTools: summary.customizedTools,
            lastChecked: healthState?.lastChecked,
            latencyMs: healthState?.latencyMs,
            error: healthState?.error,
            authStatus: authState?.status,
            authMessage: authState?.message,
            authAuthorizationServer: authState?.authorizationServer,
            managedSecretConfigured: authState?.managedSecretConfigured,
            ...buildInteractiveAuthPayload(registry, server),
          }
        })
      )

      return reply.send({ servers: result })
    })

    app.post<{ Params: { id: string } }>('/admin/servers/:id/refresh', async (request, reply) => {
      const serverId = request.params.id
      try {
        const tools = await registry.refreshTools(serverId)
        const server = await registry.getServer(serverId)
        if (!server) return reply.status(404).send({ error: 'Server not found' })
        const healthState = await registry
          .checkHealth(serverId)
          .catch(() => registry.getHealthState(serverId))
        const authState =
          server.transport === 'stdio' ? undefined : await downstreamAuthManager.getState(serverId)
        return reply.send({
          ...buildRefreshPayload(registry, server, tools.length, authState, healthState),
          authStatus: authState?.status,
          authMessage: authState?.message,
          authAuthorizationServer: authState?.authorizationServer,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const server = await registry.getServer(serverId)
        if (!server) return reply.status(404).send({ error: 'Server not found' })
        const healthState = await registry
          .checkHealth(serverId)
          .catch(() => registry.getHealthState(serverId))
        const authState =
          server.transport === 'stdio'
            ? undefined
            : await downstreamAuthManager.getState(serverId).catch(() => ({
                status: DownstreamAuthStatus.None,
                message: undefined,
                authorizationServer: undefined,
              }))
        return reply.status(400).send({
          error: msg,
          ...buildRefreshPayload(
            registry,
            server,
            await registry.getTools(serverId).then((tools) => tools.length),
            authState,
            healthState
          ),
          authStatus: authState?.status,
          authMessage: authState?.message,
          authAuthorizationServer: authState?.authorizationServer,
        })
      }
    })

    app.post<{ Params: { id: string } }>(
      '/admin/stdio-auth/servers/:id/start',
      async (request, reply) => {
        const server = await registry.getServer(request.params.id)
        if (!server) return reply.status(404).send({ error: 'Server not found' })
        if (!supportsStdioInteractiveAuth(server)) {
          return reply
            .status(400)
            .send({ error: 'Interactive stdio auth is not enabled for this server' })
        }
        try {
          return reply.send(await registry.startStdioInteractiveAuth(server.id))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return reply.status(400).send({ error: message })
        }
      }
    )

    app.get<{ Params: { id: string } }>(
      '/admin/stdio-auth/servers/:id/status',
      async (request, reply) => {
        const server = await registry.getServer(request.params.id)
        if (!server) return reply.status(404).send({ error: 'Server not found' })
        if (!supportsStdioInteractiveAuth(server)) {
          return reply
            .status(400)
            .send({ error: 'Interactive stdio auth is not enabled for this server' })
        }
        return reply.send(registry.getStdioInteractiveAuthState(server.id))
      }
    )

    app.post<{ Params: { id: string } }>(
      '/admin/stdio-auth/servers/:id/cancel',
      async (request, reply) => {
        const server = await registry.getServer(request.params.id)
        if (!server) return reply.status(404).send({ error: 'Server not found' })
        if (!supportsStdioInteractiveAuth(server)) {
          return reply
            .status(400)
            .send({ error: 'Interactive stdio auth is not enabled for this server' })
        }
        return reply.send(registry.cancelStdioInteractiveAuth(server.id))
      }
    )

    app.get<{ Params: { id: string } }>(
      '/admin/downstream-auth/servers/:id/status',
      async (request, reply) => {
        const server = await registry.getServer(request.params.id)
        if (!server) return reply.status(404).send({ error: 'Server not found' })
        return reply.send(await downstreamAuthManager.getState(server.id))
      }
    )

    app.get('/admin/downstream-auth/capabilities', async (_request, reply) => {
      return reply.send(downstreamAuthManager.getCapabilities())
    })

    app.post<{ Params: { id: string } }>(
      '/admin/downstream-auth/servers/:id/bearer-secret',
      async (request, reply) => {
        const server = await registry.getServer(request.params.id)
        if (!server) return reply.status(404).send({ error: 'Server not found' })
        if (server.auth?.mode !== 'bearer' || server.auth.source.type !== 'secret') {
          return reply
            .status(400)
            .send({ error: 'Server is not configured for a managed bearer secret' })
        }
        if (!downstreamAuthManager.getCapabilities().managedSecretsEnabled) {
          return reply.status(501).send({
            error: 'Managed downstream secrets require SQLite and DOWNSTREAM_AUTH_ENCRYPTION_KEY',
          })
        }
        const body = request.body as Record<string, unknown>
        const token = trimToUndefined(body['token'])
        if (!token) return reply.status(400).send({ error: 'token is required' })
        await downstreamAuthManager.saveManagedBearer(server.id, token)
        const state = await downstreamAuthManager.getState(server.id)
        try {
          await registry.refreshTools(server.id)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          request.log.warn(
            { err: error, serverId: server.id },
            '[admin] catalog refresh after bearer secret failed'
          )
          return reply.send({ ...state, refreshError: message })
        }
        return reply.send(state)
      }
    )

    app.post<{ Params: { id: string } }>(
      '/admin/downstream-auth/servers/:id/start',
      async (request, reply) => {
        const server = await registry.getServer(request.params.id)
        if (!server) return reply.status(404).send({ error: 'Server not found' })
        if (!downstreamAuthManager.getCapabilities().oauthStorageEnabled) {
          return reply.status(501).send({
            error: 'OAuth downstream auth requires SQLite and DOWNSTREAM_AUTH_ENCRYPTION_KEY',
          })
        }
        try {
          const result = await downstreamAuthManager.beginOAuth(
            server.id,
            getRequestOrigin(request)
          )
          return reply.send(result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return reply.status(400).send({ error: message })
        }
      }
    )

    app.get('/admin/downstream-auth/callback', async (request, reply) => {
      const query = request.query as Record<string, string | undefined>
      if (!query['state'] || !query['code']) {
        return reply
          .status(400)
          .type('text/html')
          .send('<html><body>Missing OAuth callback parameters.</body></html>')
      }
      try {
        const result = await downstreamAuthManager.completeOAuth(query['state'], query['code'])
        let refreshError: string | undefined
        try {
          await registry.refreshTools(result.serverId)
        } catch (error) {
          refreshError = error instanceof Error ? error.message : String(error)
          request.log.warn(
            { err: error, serverId: result.serverId },
            '[admin] catalog refresh after OAuth failed'
          )
        }
        const payload = JSON.stringify({
          type: 'downstream-auth:success',
          serverId: result.serverId,
          authorizationServer: result.authorizationServer,
          ...(refreshError ? { refreshError } : {}),
        })
        return reply
          .type('text/html')
          .send(
            `<html><body><script>window.opener?.postMessage(${payload}, window.location.origin);window.close();</script>Authorized.</body></html>`
          )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return reply
          .type('text/html')
          .send(
            `<html><body><script>window.opener?.postMessage({type:"downstream-auth:error",message:${JSON.stringify(message)}}, window.location.origin);</script>${message}</body></html>`
          )
      }
    })

    app.post<{ Params: { id: string } }>(
      '/admin/downstream-auth/servers/:id/disconnect',
      async (request, reply) => {
        const server = await registry.getServer(request.params.id)
        if (!server) return reply.status(404).send({ error: 'Server not found' })
        await downstreamAuthManager.disconnect(server.id)
        return reply.send(await downstreamAuthManager.getState(server.id))
      }
    )
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  if (opts.registry) {
    const registry = opts.registry

    app.get('/admin/tools', async (request, reply) => {
      const q = request.query as Record<string, string | undefined>
      const serverId = q['serverId']
      const namespace = q['namespace']

      const servers = await registry.listServers()
      const filtered = servers.filter((s) => {
        if (serverId && s.id !== serverId) return false
        if (namespace && !s.namespaces.includes(namespace)) return false
        return true
      })

      const toolsList = await Promise.all(
        filtered.map(async (server) => {
          return buildToolsForServer(registry, server, namespace)
        })
      )

      return reply.send({ tools: toolsList.flat() })
    })

    app.get<{ Params: { id: string } }>('/admin/servers/:id/schema', async (request, reply) => {
      const server = await registry.getServer(request.params.id)
      if (!server) return reply.status(404).send({ error: 'Server not found' })

      const tools = await buildToolsForServer(registry, server)
      const summary = summarizeToolEntries(tools)
      const healthState = registry.getHealthState(server.id)

      return reply.send({
        server: {
          id: server.id,
          namespaces: server.namespaces,
          transport: server.transport,
          enabled: server.enabled,
          trustLevel: server.trustLevel,
          health: healthState?.status ?? 'unknown',
          lastChecked: healthState?.lastChecked,
          latencyMs: healthState?.latencyMs,
          error: healthState?.error,
        },
        summary,
        tools,
      })
    })
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  if (opts.auditRepo) {
    const auditRepo = opts.auditRepo

    app.get('/admin/audit', async (request, reply) => {
      const q = request.query as Record<string, string | undefined>
      const filters: AuditQueryFilters = {
        sessionId: q['session_id'],
        userId: q['user_id'],
        eventType: q['event_type'] as AuditEventType | undefined,
        toolName: q['tool_name'],
        from: q['from'] ? new Date(q['from']) : undefined,
        to: q['to'] ? new Date(q['to']) : undefined,
        limit: q['limit'] ? Number(q['limit']) : 50,
        offset: q['offset'] ? Number(q['offset']) : 0,
      }

      const result = await auditRepo.query(filters)
      return reply.send(result)
    })

    app.delete('/admin/audit/prune', async (request, reply) => {
      const q = request.query as Record<string, string | undefined>
      const retentionDays = Number(q['days'] ?? process.env['AUDIT_RETENTION_DAYS'] ?? 90)
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
      const deleted = await auditRepo.deleteOlderThan(cutoff)
      return reply.send({ deleted, cutoff: cutoff.toISOString() })
    })
  }

  // ── Config ────────────────────────────────────────────────────────────────

  if (opts.configManager) {
    const configRepo = opts.configRepo
    const configManager = opts.configManager

    app.get('/admin/config', async (_request, reply) => {
      const persisted = configRepo ? await configRepo.getActive() : undefined
      const effectiveAuth = configManager.getEffective().auth
      return reply.send({
        config: configManager.getAdminConfig(),
        auth: {
          mode: effectiveAuth.mode,
          summary: buildAuthSummary(effectiveAuth),
        },
        source: persisted ? 'db' : 'file',
      })
    })

    app.get('/admin/config/auth/tokens', async (_request, reply) => {
      const effectiveAuth = configManager.getEffective().auth
      return reply.send({
        summary: buildAuthSummary(effectiveAuth),
        tokens: Object.entries(getStaticKeysForAuth(effectiveAuth) ?? {}).map(([token, entry]) => ({
          token,
          userId: entry.userId,
          roles: entry.roles,
        })),
      })
    })

    app.post('/admin/config/auth/tokens', async (request, reply) => {
      const body = (request.body as Record<string, unknown> | undefined) ?? {}
      const userId = trimToUndefined(body['userId'])
      if (!userId) {
        return reply.status(400).send({ error: 'userId is required' })
      }

      const rawRoles = Array.isArray(body['roles']) ? body['roles'] : []
      const roles = rawRoles
        .filter((role): role is string => typeof role === 'string')
        .map((role) => role.trim())
        .filter(Boolean)
      if (roles.length === 0) {
        return reply.status(400).send({ error: 'at least one role is required' })
      }

      const requestedToken = trimToUndefined(body['token'])
      const token = requestedToken ?? nanoid(40)
      const current = configManager.getAdminConfig()
      if (current.auth.mode === 'oauth') {
        return reply
          .status(400)
          .send({ error: 'Bearer tokens require static_key or hybrid auth mode' })
      }
      const existingStaticKeys = getStaticKeysForAuth(current.auth) ?? {}
      if (existingStaticKeys[token]) {
        return reply.status(409).send({ error: 'Token already exists' })
      }

      const a = current.auth
      const nextAuth =
        a.mode === 'static_key'
          ? {
              mode: 'static_key' as const,
              staticKeys: { ...existingStaticKeys, [token]: { userId, roles } },
            }
          : {
              mode: 'hybrid' as const,
              oauth: a.oauth,
              staticKeys: { ...existingStaticKeys, [token]: { userId, roles } },
            }
      const nextConfig = buildValidatedAdminConfig(configManager, {
        ...current,
        auth: nextAuth,
      })
      const persistedEntry = getStaticKeysForAuth(nextConfig.auth)?.[token]
      const version = await configManager.saveAdminConfig(nextConfig, {
        source: 'ui_edit',
        createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
        comment: `Created access token for ${userId}`,
      })

      return reply.status(201).send({ version, token, userId, roles: persistedEntry?.roles ?? [] })
    })

    app.put<{ Params: { token: string } }>(
      '/admin/config/auth/tokens/:token',
      async (request, reply) => {
        const token = request.params.token
        const current = configManager.getAdminConfig()
        if (current.auth.mode === 'oauth') {
          return reply
            .status(400)
            .send({ error: 'Bearer tokens require static_key or hybrid auth mode' })
        }
        const existing = getStaticKeysForAuth(current.auth)?.[token]
        if (!existing) {
          return reply.status(404).send({ error: 'Token not found' })
        }

        const body = (request.body as Record<string, unknown> | undefined) ?? {}
        const userId = trimToUndefined(body['userId']) ?? existing.userId
        const rawRoles = Array.isArray(body['roles']) ? body['roles'] : existing.roles
        const roles = rawRoles
          .filter((role): role is string => typeof role === 'string')
          .map((role) => role.trim())
          .filter(Boolean)
        if (roles.length === 0) {
          return reply.status(400).send({ error: 'at least one role is required' })
        }

        const a = current.auth
        const baseKeys = { ...(getStaticKeysForAuth(a) ?? {}), [token]: { userId, roles } }
        const nextAuth =
          a.mode === 'static_key'
            ? { mode: 'static_key' as const, staticKeys: baseKeys }
            : { mode: 'hybrid' as const, oauth: a.oauth, staticKeys: baseKeys }
        const nextConfig = buildValidatedAdminConfig(configManager, {
          ...current,
          auth: nextAuth,
        })
        const persistedEntry = getStaticKeysForAuth(nextConfig.auth)?.[token]
        const version = await configManager.saveAdminConfig(nextConfig, {
          source: 'ui_edit',
          createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
          comment: `Updated access token for ${userId}`,
        })

        return reply.send({ version, token, userId, roles: persistedEntry?.roles ?? [] })
      }
    )

    app.delete<{ Params: { token: string } }>(
      '/admin/config/auth/tokens/:token',
      async (request, reply) => {
        const token = request.params.token
        const current = configManager.getAdminConfig()
        if (current.auth.mode === 'oauth') {
          return reply
            .status(400)
            .send({ error: 'Bearer tokens require static_key or hybrid auth mode' })
        }
        const existingStaticKeys = { ...(getStaticKeysForAuth(current.auth) ?? {}) }
        if (!existingStaticKeys[token]) {
          return reply.status(404).send({ error: 'Token not found' })
        }
        delete existingStaticKeys[token]

        const a = current.auth
        const nextAuthDel =
          a.mode === 'static_key'
            ? { mode: 'static_key' as const, staticKeys: existingStaticKeys }
            : { mode: 'hybrid' as const, oauth: a.oauth, staticKeys: existingStaticKeys }

        const version = await configManager.saveAdminConfig(
          buildValidatedAdminConfig(configManager, {
            ...current,
            auth: nextAuthDel,
          }),
          {
            source: 'ui_edit',
            createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
            comment: `Deleted access token ${token}`,
          }
        )

        return reply.send({ version, deleted: true })
      }
    )

    app.post('/admin/config', async (request, reply) => {
      const body = request.body as AdminConfig
      const updated = buildValidatedAdminConfig(configManager, body)
      const version = await configManager.saveAdminConfig(updated, {
        source: 'api_import',
        createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
        comment: request.headers['x-comment'] as string | undefined,
      })

      return reply.status(201).send({ version })
    })

    app.get('/admin/config/versions', async (_request, reply) => {
      if (!configRepo) {
        return reply.send({ versions: [] })
      }
      const versions = await configRepo.listVersions()
      return reply.send({ versions })
    })

    app.post<{ Params: { version: string } }>(
      '/admin/config/rollback/:version',
      async (request, reply) => {
        if (!configRepo) {
          return reply.status(501).send({ error: 'Rollback requires SQLite config persistence' })
        }
        const version = Number(request.params.version)
        if (Number.isNaN(version)) {
          return reply.status(400).send({ error: 'Invalid version number' })
        }
        await configManager.rollback(version)
        return reply.send({ rolled_back_to: version })
      }
    )

    app.get('/admin/config/export', async (_request, reply) => {
      const body = JSON.stringify(configManager.getAdminConfig(), null, 2)
      reply.header('Content-Type', 'application/json; charset=utf-8')
      return reply.send(body)
    })

    app.get('/admin/config/servers', async (_request, reply) => {
      return reply.send({
        servers: configManager.getAdminConfig().servers.map(redactServerSecrets),
      })
    })

    app.post('/admin/config/servers', async (request, reply) => {
      const body = request.body as Record<string, unknown>
      const current = configManager.getAdminConfig()
      const version = await configManager.saveAdminConfig(
        buildValidatedAdminConfig(configManager, {
          ...current,
          servers: [...current.servers, body],
        }),
        {
          source: 'ui_edit',
          createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
          comment: `Added server ${typeof body['id'] === 'string' ? body['id'] : ''}`.trim(),
        }
      )
      return reply.status(201).send({ version })
    })

    app.post('/admin/config/servers/import/preview', async (request, reply) => {
      const preview = buildImportPreview(configManager.getAdminConfig(), request.body)
      return reply.send(preview)
    })

    app.post('/admin/config/servers/import', async (request, reply) => {
      const current = configManager.getAdminConfig()
      const preview = buildImportPreview(current, request.body)

      if (preview.conflicts.length > 0 || preview.validationErrors.length > 0) {
        return reply.status(400).send(preview)
      }

      const version = await configManager.saveAdminConfig(
        buildValidatedAdminConfig(configManager, {
          ...current,
          servers: [...current.servers, ...preview.normalizedServers],
        }),
        {
          source: 'api_import',
          createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
          comment: `Imported ${preview.normalizedServers.length} server${preview.normalizedServers.length === 1 ? '' : 's'}`,
        }
      )

      const runtimeWarnings = await collectImportRuntimeWarnings(
        opts.registry,
        preview.normalizedServers
      )

      return reply.status(201).send({
        version,
        imported: preview.normalizedServers.length,
        namespacesCreated: preview.namespacesToCreate,
        runtimeWarnings,
      })
    })

    app.put<{ Params: { id: string } }>('/admin/config/servers/:id', async (request, reply) => {
      const current = configManager.getAdminConfig()
      const existing = current.servers.find((server) => server.id === request.params.id)
      if (!existing) return reply.status(404).send({ error: 'Server not found' })

      const nextServer = { ...existing, ...(request.body as Record<string, unknown>) }
      const version = await configManager.saveAdminConfig(
        buildValidatedAdminConfig(configManager, {
          ...current,
          servers: current.servers.map((server) =>
            server.id === request.params.id ? nextServer : server
          ),
        }),
        {
          source: 'ui_edit',
          createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
          comment: `Updated server ${request.params.id}`,
        }
      )
      return reply.send({ version })
    })

    app.delete<{ Params: { id: string } }>('/admin/config/servers/:id', async (request, reply) => {
      const current = configManager.getAdminConfig()
      const exists = current.servers.some((server) => server.id === request.params.id)
      if (!exists) return reply.status(404).send({ error: 'Server not found' })

      const version = await configManager.saveAdminConfig(
        buildValidatedAdminConfig(configManager, {
          ...current,
          servers: current.servers.filter((server) => server.id !== request.params.id),
        }),
        {
          source: 'ui_edit',
          createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
          comment: `Deleted server ${request.params.id}`,
        }
      )
      return reply.send({ version })
    })

    app.post('/admin/namespaces', async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {}
      const namespace = typeof body['namespace'] === 'string' ? body['namespace'].trim() : ''
      const description = typeof body['description'] === 'string' ? body['description'] : undefined

      if (!namespace) {
        return reply.status(400).send({ error: 'Namespace name is required' })
      }

      const current = configManager.getAdminConfig()
      const result = createNamespaceInAdminConfig(current, namespace, description)

      if (!result.ok) {
        if (result.error === 'already_exists') {
          return reply.status(409).send({ error: `Namespace '${namespace}' already exists` })
        }
        if (result.error === 'invalid_name') {
          return reply.status(400).send({
            error:
              'Invalid namespace name. Must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores.',
          })
        }
      }

      const version = await configManager.saveAdminConfig(
        buildValidatedAdminConfig(configManager, result.config),
        {
          source: 'ui_edit',
          createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
          comment: `Created namespace ${namespace}`,
        }
      )
      return reply.send({ version })
    })

    app.get('/admin/namespaces', async (_request, reply) => {
      const current = configManager.getAdminConfig()
      const registry = opts.registry
      const namespaces = await Promise.all(
        Object.entries(current.namespaces)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(async ([key, policy]) => {
            const servers = current.servers.filter((server) => server.namespaces.includes(key))
            const disabledSet = new Set(
              (policy.disabledTools ?? []).map((r) => toolCandidateKey(r.serverId, r.name))
            )
            const rawTools = registry
              ? (
                  await Promise.all(
                    servers.map((server) => buildToolsForServer(registry, server, key))
                  )
                ).flat()
              : []
            const tools = rawTools.map((entry) => ({
              ...entry,
              enabled: !disabledSet.has(toolCandidateKey(entry.serverId, entry.name)),
            }))
            const catalogMetrics = summarizeToolEntries(tools)

            const gatewayMode: GatewayMode =
              policy.gatewayMode === GatewayMode.Code
                ? GatewayMode.Code
                : policy.gatewayMode === GatewayMode.Default
                  ? GatewayMode.Default
                  : GatewayMode.Compat

            const selector = getConfig().selector
            let sessionSummary =
              gatewayMode === GatewayMode.Default && registry
                ? summarizeClientToolWindow(
                    buildVisibleToolCatalog(
                      registry
                        .getToolsByNamespace(key)
                        .flatMap(({ server, records }) =>
                          generateToolcards(records, server, server.toolOverrides)
                        ),
                      disabledToolKeysForNamespace(getConfig(), key)
                    ),
                    selector
                  )
                : summarizeClientToolWindow(
                    buildGatewayToolWindowForMode(key, gatewayMode),
                    selector
                  )

            if (gatewayMode === GatewayMode.Default && !registry) {
              sessionSummary = {
                toolCount: 0,
                schemaTokens: 0,
                totalTokens: 0,
              }
            }

            const sessionCustomizedTools =
              gatewayMode === GatewayMode.Default ? catalogMetrics.customizedTools : 0

            const serverIdsForInstructions = registry
              ? registry.getToolsByNamespace(key).map((group) => group.server.id)
              : servers.map((server) => server.id)
            const defaultCompatInstructions =
              buildGatewayInstructions(
                GatewayMode.Compat,
                serverIdsForInstructions,
                policy.description
              ) ?? ''
            const defaultCodeInstructions =
              buildGatewayInstructions(
                GatewayMode.Code,
                serverIdsForInstructions,
                policy.description
              ) ?? ''
            const compatCustomTrim = policy.customInstructions?.compat?.trim() ?? ''
            const codeCustomTrim = policy.customInstructions?.code?.trim() ?? ''
            const rawInitializeInstructions =
              gatewayMode === GatewayMode.Default
                ? undefined
                : gatewayMode === GatewayMode.Code
                  ? codeCustomTrim.length > 0
                    ? codeCustomTrim
                    : defaultCodeInstructions
                  : compatCustomTrim.length > 0
                    ? compatCustomTrim
                    : defaultCompatInstructions
            const initializeInstructions = rawInitializeInstructions
              ? applyInstructionsPlaceholders(
                  rawInitializeInstructions,
                  serverIdsForInstructions
                )
              : undefined
            const initializeInstructionsTokens = initializeInstructions
              ? estimateSerializedTokens(initializeInstructions)
              : 0
            const firstTurnEstimatedTokens =
              sessionSummary.totalTokens + initializeInstructionsTokens

            return {
              key,
              description: policy.description ?? '',
              allowedRoles: policy.allowedRoles,
              allowedModes: policy.allowedModes,
              gatewayMode: policy.gatewayMode,
              bootstrapWindowSize: policy.bootstrapWindowSize,
              candidatePoolSize: policy.candidatePoolSize,
              telemetryEnabled: policy.telemetryEnabled ?? false,
              instructions: {
                compat: {
                  text:
                    compatCustomTrim.length > 0 ? compatCustomTrim : defaultCompatInstructions,
                  isCustom: compatCustomTrim.length > 0,
                  defaultText: defaultCompatInstructions,
                },
                code: {
                  text:
                    codeCustomTrim.length > 0 ? codeCustomTrim : defaultCodeInstructions,
                  isCustom: codeCustomTrim.length > 0,
                  defaultText: defaultCodeInstructions,
                },
              },
              servers: servers.map((server) => ({
                id: server.id,
                transport: server.transport,
                trustLevel: server.trustLevel,
              })),
              metrics: {
                toolCount: sessionSummary.toolCount,
                schemaTokens: sessionSummary.schemaTokens,
                totalTokens: sessionSummary.totalTokens,
                customizedTools: sessionCustomizedTools,
                initializeInstructionsTokens,
                firstTurnEstimatedTokens,
                serverCount: servers.length,
                averageTokensPerTool:
                  sessionSummary.toolCount > 0
                    ? Math.round(sessionSummary.totalTokens / sessionSummary.toolCount)
                    : 0,
              },
              catalogMetrics: {
                toolCount: catalogMetrics.toolCount,
                schemaTokens: catalogMetrics.schemaTokens,
                totalTokens: catalogMetrics.totalTokens,
                customizedTools: catalogMetrics.customizedTools,
                averageTokensPerTool:
                  catalogMetrics.toolCount > 0
                    ? Math.round(catalogMetrics.totalTokens / catalogMetrics.toolCount)
                    : 0,
              },
              tools,
            }
          })
      )

      return reply.send({ namespaces })
    })

    app.delete<{ Params: { namespace: string } }>(
      '/admin/namespaces/:namespace',
      async (request, reply) => {
        const namespace = decodeURIComponent(request.params.namespace)
        const current = configManager.getAdminConfig()
        const result = deleteNamespaceFromAdminConfig(current, namespace)

        if (!result.ok) {
          if (result.error === 'not_found') {
            return reply.status(404).send({ error: 'Namespace not found' })
          }
          return reply.status(400).send({
            error:
              'Cannot delete namespace: one or more servers would have no namespaces assigned. Reassign those servers first.',
            serverIds: result.serverIds,
          })
        }

        const version = await configManager.saveAdminConfig(
          buildValidatedAdminConfig(configManager, result.config),
          {
            source: 'ui_edit',
            createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
            comment:
              (request.headers['x-comment'] as string | undefined) ??
              `Deleted namespace ${namespace}`,
          }
        )
        return reply.send({ version })
      }
    )

    app.put<{ Params: { serverId: string; toolName: string } }>(
      '/admin/tools/:serverId/:toolName/override',
      async (request, reply) => {
        const { serverId, toolName } = request.params
        const current = configManager.getAdminConfig()
        const existing = current.servers.find((server) => server.id === serverId)
        if (!existing) return reply.status(404).send({ error: 'Server not found' })

        const registry = opts.registry
        const toolExists = registry
          ? (await registry.getTools(serverId)).some((tool) => tool.name === toolName)
          : true
        if (!toolExists) return reply.status(404).send({ error: 'Tool not found' })

        const body = isRecord(request.body) ? request.body : {}
        const currentOverride = existing.toolOverrides?.[toolName] ?? {}
        const nextOverride = Object.fromEntries(
          Object.entries({
            ...currentOverride,
            description: body['description'],
            inputSchema: body['inputSchema'],
            riskLevel: body['riskLevel'],
            tags: body['tags'],
            summary: body['summary'],
            namespaceHints: body['namespaceHints'],
            quarantined: body['quarantined'],
          }).filter(([, value]) => value !== undefined)
        )

        const nextOverrides = {
          ...(existing.toolOverrides ?? {}),
          [toolName]: nextOverride,
        }

        const version = await configManager.saveAdminConfig(
          buildValidatedAdminConfig(configManager, {
            ...current,
            servers: current.servers.map((server) =>
              server.id === serverId
                ? {
                    ...server,
                    toolOverrides: nextOverrides,
                  }
                : server
            ),
          }),
          {
            source: 'ui_edit',
            createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
            comment: `Updated tool override ${serverId}/${toolName}`,
          }
        )

        const saved = configManager
          .getAdminConfig()
          .servers.find((server) => server.id === serverId)
        return reply.send({
          version,
          override: saved?.toolOverrides?.[toolName] ?? null,
        })
      }
    )

    app.delete<{ Params: { serverId: string; toolName: string } }>(
      '/admin/tools/:serverId/:toolName/override',
      async (request, reply) => {
        const { serverId, toolName } = request.params
        const current = configManager.getAdminConfig()
        const existing = current.servers.find((server) => server.id === serverId)
        if (!existing) return reply.status(404).send({ error: 'Server not found' })
        if (!existing.toolOverrides?.[toolName]) {
          return reply.status(404).send({ error: 'Tool override not found' })
        }

        const nextOverrides = { ...(existing.toolOverrides ?? {}) }
        delete nextOverrides[toolName]
        const normalizedOverrides =
          Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined

        const version = await configManager.saveAdminConfig(
          buildValidatedAdminConfig(configManager, {
            ...current,
            servers: current.servers.map((server) =>
              server.id === serverId
                ? {
                    ...server,
                    toolOverrides: normalizedOverrides,
                  }
                : server
            ),
          }),
          {
            source: 'ui_edit',
            createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
            comment: `Removed tool override ${serverId}/${toolName}`,
          }
        )

        return reply.send({ version, reverted: true })
      }
    )

    app.get('/admin/config/policies', async (_request, reply) => {
      const {
        auth,
        namespaces,
        roles,
        selector,
        session,
        triggers,
        resilience,
        debug,
        codeMode,
        starterPacks,
        allowedOAuthProviders,
      } = configManager.getAdminConfig()
      return reply.send({
        auth,
        namespaces,
        roles,
        selector,
        session,
        triggers,
        resilience,
        debug,
        codeMode,
        starterPacks,
        allowedOAuthProviders,
      })
    })

    app.put('/admin/config/policies', async (request, reply) => {
      const current = configManager.getAdminConfig()
      const body = request.body as Record<string, unknown>
      const { auth: nextAuth, ...policyFields } = body
      const requestOrigin = getRequestOrigin(request)
      const version = await configManager.saveAdminConfig(
        buildValidatedAdminConfig(configManager, {
          ...current,
          auth: mergeInboundAuthPolicy(current.auth, nextAuth, requestOrigin),
          ...policyFields,
        }),
        {
          source: 'ui_edit',
          createdBy: (request.headers['x-user-id'] as string | undefined) ?? 'admin',
          comment: (request.headers['x-comment'] as string | undefined) ?? 'Updated policies',
        }
      )
      return reply.send({ version })
    })
  }
}
