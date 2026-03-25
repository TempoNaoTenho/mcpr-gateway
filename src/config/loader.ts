import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ZodError } from 'zod'
import { Mode } from '../types/enums.js'
import {
  PoliciesFileSchema,
  GatewayConfigFileSchema,
  BootstrapAuthConfigSchema,
} from './schemas.js'
import type {
  ServersFile,
  PoliciesFile,
  AuthConfig,
  BootstrapAuthConfig,
  TriggerPolicy,
  ResilienceConfig,
} from './schemas.js'

export interface GatewayConfig {
  servers: ServersFile['servers']
  auth: AuthConfig
  namespaces: PoliciesFile['namespaces']
  roles: PoliciesFile['roles']
  selector: PoliciesFile['selector']
  session: PoliciesFile['session']
  triggers: TriggerPolicy
  resilience: ResilienceConfig
  debug: PoliciesFile['debug']
  codeMode: PoliciesFile['codeMode']
  starterPacks: PoliciesFile['starterPacks']
  allowedOAuthProviders: string[]
}

export interface BootstrapConfig {
  auth: BootstrapAuthConfig
}

export interface AdminAuthConfig {
  staticKeys?: AuthConfig['staticKeys']
}

// Fields managed by the admin UI and safe to persist in the database.
export type AdminConfig = Omit<GatewayConfig, 'auth'> & { auth: AdminAuthConfig }

const DEFAULT_SERVER_HEALTHCHECK = {
  enabled: true,
  intervalSeconds: 30,
} as const

function applyServerDefaults<T extends { servers: GatewayConfig['servers'] }>(config: T): T {
  return {
    ...config,
    servers: config.servers.map((server) => ({
      ...server,
      healthcheck: server.healthcheck ?? DEFAULT_SERVER_HEALTHCHECK,
    })),
  }
}

export function toAdminConfig(config: GatewayConfig): AdminConfig {
  const { auth, ...admin } = applyServerDefaults(config)
  return {
    ...admin,
    auth: {
      staticKeys: auth.staticKeys,
    },
  }
}

export function mergeWithAdminConfig(base: BootstrapConfig, override: AdminConfig): GatewayConfig {
  const { auth: adminAuth = {}, ...rest } = override
  return normalizeGatewayConfig({
    auth: {
      ...base.auth,
      staticKeys: adminAuth.staticKeys,
    },
    ...rest,
  })
}

export function normalizeGatewayConfig(config: GatewayConfig): GatewayConfig {
  return applyServerDefaults(GatewayConfigFileSchema.parse(config))
}

function interpolateEnvVars(raw: string): string {
  const missing: string[] = []
  const result = raw.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, name: string) => {
    const value = process.env[name]
    if (value === undefined) {
      missing.push(name)
      return match
    }
    return value
  })
  if (missing.length > 0) {
    console.error('[config] Missing required environment variables:')
    for (const name of missing) {
      console.error(`  ${name}`)
    }
    process.exit(1)
  }
  return result
}

function loadGatewayJson(filePath: string): unknown | null {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : undefined

    if (code === 'ENOENT') {
      return null
    }
    console.error(`[config] Failed to read ${filePath}:`, err)
    process.exit(1)
  }

  const interpolated = interpolateEnvVars(raw)
  try {
    return JSON.parse(interpolated)
  } catch (parseErr) {
    console.error(`[config] Invalid JSON at ${filePath}:`, parseErr)
    process.exit(1)
  }
}

function createDefaultPolicies(serverNamespaces: string[]): PoliciesFile {
  const namespaces = [...new Set(serverNamespaces)].sort()
  const effectiveNamespaces = namespaces.length > 0 ? namespaces : ['default']

  return PoliciesFileSchema.parse({
    auth: { mode: 'static_key' },
    namespaces: Object.fromEntries(
      effectiveNamespaces.map((namespace) => [
        namespace,
        {
          allowedRoles: ['user', 'admin'],
          bootstrapWindowSize: 4,
          candidatePoolSize: 16,
          allowedModes: [Mode.Read, Mode.Write],
        },
      ])
    ),
    roles: {
      user: {
        allowNamespaces: effectiveNamespaces,
        denyModes: [Mode.Admin],
      },
      admin: {
        allowNamespaces: effectiveNamespaces,
      },
    },
  })
}

export function createDefaultAdminConfig(serverNamespaces: string[] = []): AdminConfig {
  const policies = createDefaultPolicies(serverNamespaces)
  return {
    auth: {
      staticKeys: undefined,
    },
    servers: [],
    namespaces: policies.namespaces,
    roles: policies.roles,
    selector: policies.selector,
    session: policies.session,
    triggers: policies.triggers,
    resilience: policies.resilience,
    debug: policies.debug,
    codeMode: policies.codeMode,
    starterPacks: policies.starterPacks,
    allowedOAuthProviders: [],
  }
}

function createBootstrapConfig(raw: unknown): BootstrapConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { auth: { mode: 'static_key' } }
  }

  const authValue = 'auth' in raw ? (raw as { auth?: unknown }).auth : undefined
  if (authValue === undefined) {
    return { auth: { mode: 'static_key' } }
  }

  if (authValue && typeof authValue === 'object' && !Array.isArray(authValue)) {
    const authRecord = authValue as Record<string, unknown>

    if (authRecord['mode'] === 'mock_dev') {
      console.error('[config] Invalid bootstrap.json.auth:')
      console.error('  - auth.mode "mock_dev" has been removed; use "static_key".')
      process.exit(1)
    }

    if ('staticKeys' in authRecord) {
      console.error('[config] Invalid bootstrap.json.auth:')
      console.error(
        '  - auth.staticKeys is no longer supported in bootstrap.json; manage client tokens through the admin config/auth endpoints.'
      )
      process.exit(1)
    }
  }

  return {
    auth: validateSchema(BootstrapAuthConfigSchema, authValue, 'bootstrap.json.auth'),
  }
}

function logBootstrapUsage(dir: string, gatewayFound: boolean): void {
  if (gatewayFound) {
    return
  }
  console.warn(
    `[config] Missing ${join(dir, 'bootstrap.json')}; starting with built-in defaults and zero downstream servers.`
  )
}

function validateSchema<T>(
  schema: { parse: (data: unknown) => T },
  data: unknown,
  fileName: string
): T {
  try {
    return schema.parse(data)
  } catch (err) {
    if (err instanceof ZodError) {
      console.error(`[config] Invalid schema in ${fileName}:`)
      console.error(err.format())
    } else {
      console.error(`[config] Unexpected validation error in ${fileName}:`, err)
    }
    process.exit(1)
  }
}

export function validateGatewayConfig(config: GatewayConfig): GatewayConfig {
  const errors: string[] = []
  const warnings: string[] = []

  const namespaceKeys = new Set(Object.keys(config.namespaces))
  const roleKeys = new Set(Object.keys(config.roles))
  const serverIds = new Set<string>()

  for (const server of config.servers) {
    if (serverIds.has(server.id)) {
      errors.push(`duplicate server id "${server.id}"`)
    }
    serverIds.add(server.id)
    for (const ns of server.namespaces) {
      if (!namespaceKeys.has(ns)) {
        errors.push(`server "${server.id}" references unknown namespace "${ns}"`)
      }
    }
  }

  for (const ns of Object.keys(config.starterPacks)) {
    if (!namespaceKeys.has(ns)) {
      errors.push(`starterPacks key "${ns}" references unknown namespace "${ns}"`)
    }
  }

  for (const [ns, policy] of Object.entries(config.namespaces)) {
    for (const role of policy.allowedRoles) {
      if (!roleKeys.has(role)) {
        warnings.push(`namespace "${ns}" references unknown role "${role}"`)
      }
    }
  }

  for (const warning of warnings) {
    console.warn(`[config] Warning: ${warning}`)
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }

  return config
}

export function loadConfig(configPath?: string): GatewayConfig {
  const dir = configPath ?? process.env['CONFIG_PATH'] ?? './config'
  const gatewayPath = join(dir, 'bootstrap.json')
  const raw = loadGatewayJson(gatewayPath)

  let config: GatewayConfig

  if (raw === null) {
    config = mergeWithAdminConfig({ auth: { mode: 'static_key' } }, createDefaultAdminConfig())
  } else {
    const bootstrap = createBootstrapConfig(raw)
    const parsed = validateSchema(GatewayConfigFileSchema, raw, 'bootstrap.json')
    const defaults = createDefaultAdminConfig(parsed.servers.flatMap((server) => server.namespaces))
    config = mergeWithAdminConfig(bootstrap, {
      ...defaults,
      ...toAdminConfig(parsed),
    })
  }

  try {
    validateGatewayConfig(config)
  } catch (err) {
    console.error('[config] Cross-section validation failed:')
    console.error(`  - ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  logBootstrapUsage(dir, raw !== null)

  return config
}
