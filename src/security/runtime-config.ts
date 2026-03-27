export const DEFAULT_GATEWAY_ADMIN_USER = 'mcpgateway'

export function trimToUndefined(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function getGatewayAdminUserFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return trimToUndefined(env['GATEWAY_ADMIN_USER']) ?? DEFAULT_GATEWAY_ADMIN_USER
}

export function hasValidDownstreamAuthEncryptionKey(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = trimToUndefined(env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'])
  if (!raw) return false
  try {
    return Buffer.from(raw, 'base64').length === 32
  } catch {
    return false
  }
}

export function assertRuntimeSecurityConfig(
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<typeof console, 'warn'> = console
): void {
  const adminToken = trimToUndefined(env['ADMIN_TOKEN'])
  const adminPassword = trimToUndefined(env['GATEWAY_ADMIN_PASSWORD'])
  const encryptionKey = trimToUndefined(env['DOWNSTREAM_AUTH_ENCRYPTION_KEY'])
  const adminUser = getGatewayAdminUserFromEnv(env)

  if (adminToken && !adminPassword) {
    throw new Error(
      'ADMIN_TOKEN requires GATEWAY_ADMIN_PASSWORD to be set to a non-empty value.'
    )
  }

  if (encryptionKey && !hasValidDownstreamAuthEncryptionKey(env)) {
    throw new Error(
      'DOWNSTREAM_AUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte key.'
    )
  }

  if (env['NODE_ENV'] === 'production' && adminToken && adminUser === DEFAULT_GATEWAY_ADMIN_USER) {
    logger.warn(
      '[gateway] GATEWAY_ADMIN_USER is using the default "mcpgateway" in production. Set an explicit username before publishing.'
    )
  }
}
