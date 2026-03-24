import { z } from 'zod'
import {
  DownstreamAuthStatus,
  DownstreamHealth,
  SourceTrustLevel,
  StdioInteractiveAuthStatus,
} from './enums.js'
import { ToolcardOverrideSchema } from './tools.js'

const HttpTransportSchema = z.enum(['http', 'streamable-http'])
const NonEmptyStringSchema = z.string().min(1)
const StdioInteractiveAuthConfigSchema = z.object({
  enabled: z.boolean(),
})
const DownstreamAuthBearerSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('env'),
    envVar: NonEmptyStringSchema,
  }),
  z.object({
    type: z.literal('secret'),
  }),
  z.object({
    type: z.literal('literal'),
    value: NonEmptyStringSchema,
  }),
])
const DownstreamAuthRegistrationSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('dynamic'),
  }),
  z.object({
    mode: z.literal('static'),
    clientId: NonEmptyStringSchema,
    clientSecretSecretRef: NonEmptyStringSchema.optional(),
  }),
])
export const DownstreamAuthSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('none'),
  }),
  z.object({
    mode: z.literal('bearer'),
    headerName: NonEmptyStringSchema.optional(),
    scheme: NonEmptyStringSchema.optional(),
    source: DownstreamAuthBearerSourceSchema,
  }),
  z.object({
    mode: z.literal('oauth'),
    authorizationServer: z.string().url().optional(),
    resource: NonEmptyStringSchema.optional(),
    scopes: z.array(NonEmptyStringSchema).default([]),
    registration: DownstreamAuthRegistrationSchema.default({ mode: 'dynamic' }),
  }),
])
const SourceTrustLevelSchema = z
  .enum(['untrusted', 'verified', 'internal', 'normal', 'high'])
  .transform((trustLevel) => {
    if (trustLevel === 'normal') return SourceTrustLevel.Verified
    if (trustLevel === 'high') return SourceTrustLevel.Internal
    return trustLevel
  })

export const DownstreamServerSchema = z.preprocess(
  (data) => {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const d = data as Record<string, unknown>
      if (typeof d['namespace'] === 'string' && !Array.isArray(d['namespaces'])) {
        const { namespace, ...rest } = d
        return { ...rest, namespaces: [namespace] }
      }
    }
    return data
  },
  z
  .object({
    id: z.string().min(1),
    namespaces: z.array(z.string().min(1)).min(1),
    transport: z.union([z.literal('stdio'), HttpTransportSchema]),
    url: z.string().url().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    stdioTimeoutSeconds: z.number().int().positive().optional(),
    stdioInteractiveAuth: StdioInteractiveAuthConfigSchema.optional(),
    headers: z.record(z.string()).optional(),
    auth: DownstreamAuthSchema.optional(),
    enabled: z.boolean(),
    trustLevel: SourceTrustLevelSchema,
    refreshIntervalSeconds: z.number().int().positive().optional(),
    healthcheck: z
      .object({
        enabled: z.boolean(),
        intervalSeconds: z.number().int().positive(),
      })
      .optional(),
    discovery: z
      .object({
        mode: z.enum(['manual', 'auto']),
      })
      .optional(),
    toolOverrides: z.record(z.string().min(1), ToolcardOverrideSchema).optional(),
  })
  .superRefine((server, ctx) => {
    if (server.transport === 'stdio' && !server.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`command` is required when transport is `stdio`',
        path: ['command'],
      })
    }

    if (server.transport === 'stdio' && server.headers !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`headers` is not supported when transport is `stdio`',
        path: ['headers'],
      })
    }

    if (server.transport === 'stdio' && server.auth !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`auth` is not supported when transport is `stdio`',
        path: ['auth'],
      })
    }

    if (server.transport !== 'stdio' && server.stdioInteractiveAuth !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`stdioInteractiveAuth` is only supported when transport is `stdio`',
        path: ['stdioInteractiveAuth'],
      })
    }

    if (server.transport !== 'stdio' && !server.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`url` is required when transport is HTTP-based',
        path: ['url'],
      })
    }

    if (server.transport !== 'stdio' && server.args !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`args` is only supported when transport is `stdio`',
        path: ['args'],
      })
    }

    if (server.transport !== 'stdio' && server.env !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`env` is only supported when transport is `stdio`',
        path: ['env'],
      })
    }

    if (server.transport !== 'stdio' && server.stdioTimeoutSeconds !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`stdioTimeoutSeconds` is only supported when transport is `stdio`',
        path: ['stdioTimeoutSeconds'],
      })
    }
  }),
)

export type DownstreamServer = z.infer<typeof DownstreamServerSchema>
export type DownstreamServerAuth = z.infer<typeof DownstreamAuthSchema>

export function supportsStdioInteractiveAuth(server: DownstreamServer): boolean {
  return server.transport === 'stdio' && server.stdioInteractiveAuth?.enabled === true
}

export const ServerConfigSchema = z.object({
  servers: z.array(DownstreamServerSchema),
})

export type ServerConfig = z.infer<typeof ServerConfigSchema>

export const HealthStateSchema = z.object({
  serverId: z.string().min(1),
  status: z.nativeEnum(DownstreamHealth),
  lastChecked: z.string().datetime(),
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
})

export type HealthState = z.infer<typeof HealthStateSchema>

export const DownstreamAuthStateSchema = z.object({
  serverId: z.string().min(1),
  status: z.nativeEnum(DownstreamAuthStatus),
  message: z.string().optional(),
  challenge: z.string().optional(),
  lastAuthenticatedAt: z.string().datetime().optional(),
  managedSecretConfigured: z.boolean().default(false),
  authorizationServer: z.string().url().optional(),
})

export type DownstreamAuthState = z.infer<typeof DownstreamAuthStateSchema>

export const StdioInteractiveAuthStateSchema = z.object({
  serverId: z.string().min(1),
  status: z.nativeEnum(StdioInteractiveAuthStatus),
  message: z.string().optional(),
  url: z.string().url().optional(),
  lastUpdatedAt: z.string().datetime(),
})

export type StdioInteractiveAuthState = z.infer<typeof StdioInteractiveAuthStateSchema>
