import { base } from '$app/paths'

type FetchFn = typeof fetch

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: { field: string; message: string }[],
    public details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  fetchFn: FetchFn = fetch
): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const res = await fetchFn(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(res.status, body.error ?? res.statusText, body.issues, body)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function login(username: string, password: string): Promise<void> {
  await request('/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export async function logout(): Promise<void> {
  await request('/admin/auth/logout', { method: 'POST' })
}

export async function authMe(): Promise<{ authenticated: boolean }> {
  return request('/admin/auth/me')
}

export async function authConfig(): Promise<{ username: string; passwordRequired: boolean }> {
  return request('/admin/auth/config')
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export interface DashboardData {
  sessions: { active: number; total: number }
  servers: { total: number; healthy: number; degraded: number; offline: number }
  tools: { total: number; quarantined: number }
  recentEvents: AuditEvent[]
  errorRate1h: number
  gateway: {
    listenHost: string
    listenPort: number
    listenSource: 'bound' | 'env'
  }
}

export async function getDashboard(): Promise<DashboardData> {
  return request('/admin/dashboard')
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export interface SessionState {
  id: string
  userId: string
  namespace: string
  mode: string
  status: 'cold' | 'active' | 'expired' | 'revoked'
  toolWindow: VisibleTool[]
  createdAt: string
  lastActiveAt: string
  refreshCount: number
  refreshHistory?: { triggeredBy: string; timestamp: string; toolCount: number }[]
}

export interface VisibleTool {
  name: string
  description?: string
  serverId: string
  riskLevel?: string
}

export interface SessionListResult {
  sessions: SessionState[]
  total: number
}

export async function getSessions(params?: {
  namespace?: string
  status?: string
  limit?: number
  offset?: number
}): Promise<SessionListResult> {
  const qs = new URLSearchParams()
  if (params?.namespace) qs.set('namespace', params.namespace)
  if (params?.status) qs.set('status', params.status)
  if (params?.limit !== undefined) qs.set('limit', String(params.limit))
  if (params?.offset !== undefined) qs.set('offset', String(params.offset))
  const query = qs.toString() ? `?${qs}` : ''
  return request(`/admin/sessions${query}`)
}

export async function getSession(id: string): Promise<SessionState> {
  return request(`/admin/sessions/${id}`)
}

export async function deleteSession(id: string): Promise<void> {
  await request(`/admin/sessions/${id}`, { method: 'DELETE' })
}

// ── Servers ───────────────────────────────────────────────────────────────────

export interface ServerInfo {
  id: string
  namespaces: string[]
  transport: string
  stdioInteractiveAuth?: {
    enabled: boolean
  }
  url?: string
  command?: string
  enabled: boolean
  trustLevel: string
  health: string
  toolCount: number
  schemaTokens: number
  totalTokens: number
  customizedTools: number
  lastChecked?: string
  latencyMs?: number
  error?: string
  authStatus?: string
  authMessage?: string
  managedSecretConfigured?: boolean
  interactiveAuthStatus?: string
  interactiveAuthMessage?: string
  interactiveAuthUrl?: string
}

export async function getServers(): Promise<{ servers: ServerInfo[] }> {
  return request('/admin/servers')
}

export async function refreshServer(id: string): Promise<{
  toolCount: number
  health: string
  lastChecked?: string
  latencyMs?: number
  error?: string
  authStatus?: string
  authMessage?: string
  interactiveAuthStatus?: string
  interactiveAuthMessage?: string
  interactiveAuthUrl?: string
}> {
  return request(`/admin/servers/${id}/refresh`, { method: 'POST' })
}

export async function startStdioInteractiveAuth(serverId: string): Promise<{
  serverId: string
  status: string
  message?: string
  url?: string
  lastUpdatedAt: string
}> {
  return request(`/admin/stdio-auth/servers/${serverId}/start`, { method: 'POST' })
}

export async function getStdioInteractiveAuthStatus(serverId: string): Promise<{
  serverId: string
  status: string
  message?: string
  url?: string
  lastUpdatedAt: string
}> {
  return request(`/admin/stdio-auth/servers/${serverId}/status`)
}

export async function cancelStdioInteractiveAuth(serverId: string): Promise<{
  serverId: string
  status: string
  message?: string
  url?: string
  lastUpdatedAt: string
}> {
  return request(`/admin/stdio-auth/servers/${serverId}/cancel`, { method: 'POST' })
}

export interface ConfigServerAuth {
  mode: 'none' | 'bearer' | 'oauth'
  headerName?: string
  scheme?: string
  source?: { type: 'env'; envVar: string } | { type: 'secret' } | { type: 'literal'; value: string }
  authorizationServer?: string
  resource?: string
  scopes?: string[]
  registration?:
    | { mode: 'dynamic' }
    | { mode: 'static'; clientId: string; clientSecretSecretRef?: string }
}

export interface ConfigServer {
  id: string
  namespaces: string[]
  transport: 'stdio' | 'http' | 'streamable-http'
  stdioInteractiveAuth?: {
    enabled: boolean
  }
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  stdioTimeoutSeconds?: number
  headers?: Record<string, string>
  auth?: ConfigServerAuth
  enabled: boolean
  trustLevel: string
  refreshIntervalSeconds?: number
  healthcheck?: {
    enabled: boolean
    intervalSeconds: number
  }
  discovery?: {
    mode: 'manual' | 'auto'
  }
  toolOverrides?: Record<string, ToolOverride>
}

export async function getConfigServers(): Promise<{ servers: ConfigServer[] }> {
  return request('/admin/config/servers')
}

export async function createConfigServer(server: ConfigServer): Promise<{ version: number }> {
  return request('/admin/config/servers', {
    method: 'POST',
    body: JSON.stringify(server),
  })
}

export async function updateConfigServer(
  id: string,
  server: Partial<ConfigServer>
): Promise<{ version: number }> {
  return request(`/admin/config/servers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(server),
  })
}

export async function deleteConfigServer(id: string): Promise<{ version: number }> {
  return request(`/admin/config/servers/${id}`, { method: 'DELETE' })
}

export interface ConfigServerImportPreview {
  normalizedServers: ConfigServer[]
  conflicts: Array<{ id: string; message: string }>
  validationErrors: Array<{ id: string; field: string; message: string }>
  namespacesToCreate: string[]
}

export interface ImportRuntimeWarning {
  id: string
  message: string
}

export interface ConfigServerImportPayload {
  defaultNamespace?: string
  mcpServers: Record<string, unknown>
}

export async function previewConfigServerImport(
  payload: ConfigServerImportPayload
): Promise<ConfigServerImportPreview> {
  return request('/admin/config/servers/import/preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function importConfigServers(payload: ConfigServerImportPayload): Promise<{
  version: number
  imported: number
  namespacesCreated: string[]
  runtimeWarnings: ImportRuntimeWarning[]
}> {
  return request('/admin/config/servers/import', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function getDownstreamAuthStatus(serverId: string): Promise<{
  serverId: string
  status: string
  message?: string
  managedSecretConfigured: boolean
  authorizationServer?: string
}> {
  return request(`/admin/downstream-auth/servers/${encodeURIComponent(serverId)}/status`)
}

export async function getDownstreamAuthCapabilities(): Promise<{
  managedSecretsEnabled: boolean
  oauthStorageEnabled: boolean
}> {
  return request('/admin/downstream-auth/capabilities')
}

export async function setDownstreamBearerSecret(
  serverId: string,
  token: string
): Promise<{
  serverId: string
  status: string
  managedSecretConfigured: boolean
  refreshError?: string
}> {
  return request(`/admin/downstream-auth/servers/${encodeURIComponent(serverId)}/bearer-secret`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

export async function startDownstreamOAuth(serverId: string): Promise<{ authorizeUrl: string }> {
  return request(`/admin/downstream-auth/servers/${encodeURIComponent(serverId)}/start`, {
    method: 'POST',
  })
}

export async function disconnectDownstreamAuth(serverId: string): Promise<{
  serverId: string
  status: string
  managedSecretConfigured: boolean
}> {
  return request(`/admin/downstream-auth/servers/${encodeURIComponent(serverId)}/disconnect`, {
    method: 'POST',
  })
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export interface ToolRecord {
  name: string
  serverId: string
  namespace: string
  serverNamespaces: string[]
  riskLevel: string
  customized: boolean
  hasSchemaOverride: boolean
  hasDescriptionOverride: boolean
  originalDescription?: string
  effectiveDescription?: string
  originalInputSchema: Record<string, unknown>
  effectiveInputSchema: Record<string, unknown>
  schemaTokens: number
  totalTokens: number
  /** Present on namespace tool listings; omitted elsewhere. */
  enabled?: boolean
}

export async function getTools(params?: {
  serverId?: string
  namespace?: string
}): Promise<{ tools: ToolRecord[] }> {
  const qs = new URLSearchParams()
  if (params?.serverId) qs.set('serverId', params.serverId)
  if (params?.namespace) qs.set('namespace', params.namespace)
  const query = qs.toString() ? `?${qs}` : ''
  return request(`/admin/tools${query}`)
}

export interface ToolOverride {
  description?: string
  inputSchema?: Record<string, unknown>
  riskLevel?: string
  tags?: string[]
  summary?: string
  namespaceHints?: string[]
  quarantined?: boolean
}

export async function saveToolOverride(
  serverId: string,
  toolName: string,
  override: ToolOverride
): Promise<{ version: number; override: ToolOverride | null }> {
  return request(
    `/admin/tools/${encodeURIComponent(serverId)}/${encodeURIComponent(toolName)}/override`,
    {
      method: 'PUT',
      body: JSON.stringify(override),
    }
  )
}

export async function deleteToolOverride(
  serverId: string,
  toolName: string
): Promise<{ version: number; reverted: boolean }> {
  return request(
    `/admin/tools/${encodeURIComponent(serverId)}/${encodeURIComponent(toolName)}/override`,
    {
      method: 'DELETE',
    }
  )
}

export interface ServerSchemaSummary {
  toolCount: number
  schemaTokens: number
  totalTokens: number
  customizedTools: number
}

export interface ServerSchemaDetail {
  server: {
    id: string
    namespaces: string[]
    transport: string
    enabled: boolean
    trustLevel: string
    health: string
    lastChecked?: string
    latencyMs?: number
    error?: string
  }
  summary: ServerSchemaSummary
  tools: ToolRecord[]
}

export async function getServerSchema(serverId: string): Promise<ServerSchemaDetail> {
  return request(`/admin/servers/${encodeURIComponent(serverId)}/schema`)
}

export interface NamespaceSummary {
  key: string
  allowedRoles: string[]
  allowedModes: string[]
  gatewayMode: 'compat' | 'code' | 'default'
  bootstrapWindowSize: number
  candidatePoolSize: number
  servers: Array<{
    id: string
    transport: string
    trustLevel: string
  }>
  metrics: {
    toolCount: number
    schemaTokens: number
    totalTokens: number
    customizedTools: number
    serverCount: number
    averageTokensPerTool: number
  }
  tools: ToolRecord[]
}

export async function getNamespaces(): Promise<{ namespaces: NamespaceSummary[] }> {
  return request('/admin/namespaces')
}

export async function deleteNamespace(key: string, comment?: string): Promise<{ version: number }> {
  return request(`/admin/namespaces/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: comment ? { 'x-comment': comment } : {},
  })
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export interface AuditEvent {
  id?: number
  type: string
  sessionId?: string
  userId?: string
  toolName?: string
  serverId?: string
  outcome?: string
  latencyMs?: number
  toolCount?: number
  reason?: string
  timestamp: string
  payload?: unknown
}

export interface AuditResult {
  events: AuditEvent[]
  total: number
}

export async function getAuditLogs(params?: {
  session_id?: string
  user_id?: string
  event_type?: string
  tool_name?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}): Promise<AuditResult> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined) qs.set(k, String(v))
  }
  const query = qs.toString() ? `?${qs}` : ''
  return request(`/admin/audit${query}`)
}

export async function pruneAuditLogs(days?: number): Promise<{ deleted: number; cutoff: string }> {
  const qs = days !== undefined ? `?days=${days}` : ''
  return request(`/admin/audit/prune${qs}`, { method: 'DELETE' })
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface AuthSummary {
  clientAuth: 'bearer_tokens'
  clientTokensConfigured: number
  adminTokenConfigured: boolean
  devModeEnabled: boolean
}

export type ConfigSource = 'db' | 'file'

export async function getConfig(): Promise<{
  config: unknown
  auth?: { mode?: string; summary?: AuthSummary }
  source: ConfigSource
}> {
  return request('/admin/config')
}

export interface AuthTokenConfig {
  token: string
  userId: string
  roles: string[]
}

export async function getAuthTokens(): Promise<{
  summary: AuthSummary
  tokens: AuthTokenConfig[]
}> {
  return request('/admin/config/auth/tokens')
}

export async function createAuthToken(payload: {
  userId: string
  roles: string[]
  token?: string
}): Promise<{ version: number; token: string; userId: string; roles: string[] }> {
  return request('/admin/config/auth/tokens', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function updateAuthToken(
  token: string,
  payload: {
    userId?: string
    roles?: string[]
  }
): Promise<{ version: number; token: string; userId: string; roles: string[] }> {
  return request(`/admin/config/auth/tokens/${encodeURIComponent(token)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function deleteAuthToken(
  token: string
): Promise<{ version: number; deleted: boolean }> {
  return request(`/admin/config/auth/tokens/${encodeURIComponent(token)}`, {
    method: 'DELETE',
  })
}

export async function saveConfig(
  config: unknown,
  meta?: { comment?: string }
): Promise<{ version: number }> {
  return request('/admin/config', {
    method: 'POST',
    body: JSON.stringify(config),
    headers: meta?.comment ? { 'x-comment': meta.comment } : {},
  })
}

export async function getConfigVersions(): Promise<{
  versions: { id: number; createdAt: string; source: string; createdBy: string; comment?: string }[]
}> {
  return request('/admin/config/versions')
}

export async function rollbackConfig(version: number): Promise<{ rolled_back_to: number }> {
  return request(`/admin/config/rollback/${version}`, { method: 'POST' })
}

export async function exportConfig(): Promise<string> {
  const res = await fetch('/admin/config/export', { credentials: 'same-origin' })
  if (!res.ok) throw new ApiError(res.status, res.statusText)
  return res.text()
}

export interface PoliciesConfig {
  auth: {
    staticKeys?: Record<
      string,
      {
        userId: string
        roles: string[]
      }
    >
  }
  namespaces: Record<
    string,
    {
      allowedRoles: string[]
      bootstrapWindowSize: number
      candidatePoolSize: number
      allowedModes: string[]
      gatewayMode: 'compat' | 'code' | 'default'
      disabledTools?: { serverId: string; name: string }[]
    }
  >
  roles: Record<
    string,
    {
      allowNamespaces: string[]
      denyModes?: string[]
    }
  >
  selector: {
    lexical: { enabled: boolean }
    vector: { enabled: boolean }
    penalties: {
      write: number
      admin: number
      unhealthyDownstream: number
    }
    focus: {
      enabled: boolean
      lookback: number
      minDominantSuccesses: number
      reserveSlots: number
      crossDomainPenalty: number
    }
    publication: {
      descriptionCompression: 'off' | 'conservative'
      schemaCompression: 'off' | 'conservative'
      descriptionMaxLength: number
    }
    discoveryTool: {
      enabled: boolean
      resultLimit: number
      promoteCount: number
    }
  }
  session: {
    ttlSeconds: number
    cleanupIntervalSeconds: number
  }
  triggers: {
    refreshOnSuccess: boolean
    refreshOnTimeout: boolean
    refreshOnError: boolean
    replaceOrAppend: 'replace' | 'append'
    cooldownSeconds: number
  }
  resilience: {
    timeouts: { connectMs: number; responseMs: number; totalMs: number }
    rateLimit: {
      perSession: { maxRequests: number; windowSeconds: number }
      perUser: { maxRequests: number; windowSeconds: number }
      perDownstreamConcurrency: number
    }
    circuitBreaker: {
      degradedAfterFailures: number
      offlineAfterFailures: number
      resetAfterSeconds: number
    }
  }
  debug: { enabled: boolean }
  codeMode: {
    memoryLimitMb: number
    executionTimeoutMs: number
    maxToolCallsPerExecution: number
    maxResultSizeBytes: number
    artifactStoreTtlSeconds: number
  }
  starterPacks: Record<
    string,
    {
      preferredTags: string[]
      maxTools: number
      includeRiskLevels: string[]
      includeModes: string[]
    }
  >
}

export async function getPolicies(): Promise<PoliciesConfig> {
  return request('/admin/config/policies')
}

export async function savePolicies(
  policies: PoliciesConfig,
  comment?: string
): Promise<{ version: number }> {
  return request('/admin/config/policies', {
    method: 'PUT',
    body: JSON.stringify(policies),
    headers: comment ? { 'x-comment': comment } : {},
  })
}

export { ApiError }
