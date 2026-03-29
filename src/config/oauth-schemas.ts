import { z } from 'zod'

function blankToUndefined(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const OptionalUrlSchema = z.preprocess(blankToUndefined, z.string().url().optional())
const OptionalNonEmptyStringSchema = z.preprocess(blankToUndefined, z.string().min(1).optional())
const LooseObjectSchema = z.record(z.unknown())

export const DEFAULT_EMBEDDED_BROWSER_ORIGINS = [
  'https://chatgpt.com',
  'https://claude.ai',
  'https://claude.com',
] as const

export const IssuerConfigSchema = z.object({
  issuer: z.string().url(),
  audience: z.string().min(1).optional(),
  jwksUri: z.string().url().optional(),
  rolesClaim: z.string().min(1).default('roles'),
})

export type IssuerConfig = z.infer<typeof IssuerConfigSchema>

export const IssuerConfigDraftSchema = z.object({
  issuer: OptionalUrlSchema,
  audience: OptionalNonEmptyStringSchema,
  jwksUri: OptionalUrlSchema,
  rolesClaim: OptionalNonEmptyStringSchema.default('roles'),
})

export type IssuerConfigDraft = z.infer<typeof IssuerConfigDraftSchema>

export const InboundOAuthSchema = z
  .object({
    provider: z.enum(['embedded', 'external']).optional(),
    publicBaseUrl: OptionalUrlSchema,
    authorizationServers: z.array(IssuerConfigDraftSchema).default([]),
    requireForNamespaces: z.array(z.string().min(1)).optional(),
    scopesSupported: z.array(z.string().min(1)).optional(),
    /** Origins allowed for browser MCP clients (e.g. https://chatgpt.com). Empty = loopback-only CORS behavior. */
    allowedBrowserOrigins: z.array(z.string().min(1)).optional(),
    embedded: z
      .object({
        keyId: OptionalNonEmptyStringSchema,
        privateJwk: LooseObjectSchema.optional(),
        publicJwk: LooseObjectSchema.optional(),
      })
      .optional(),
  })
  .superRefine((o, ctx) => {
    const provider = o.provider ?? (o.authorizationServers.length > 0 ? 'external' : 'embedded')
    if (provider === 'external') {
      if (!o.publicBaseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'publicBaseUrl is required for external OAuth',
          path: ['publicBaseUrl'],
        })
      } else if (!o.publicBaseUrl.startsWith('https://') && process.env['NODE_ENV'] === 'production') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'publicBaseUrl must use https:// in production',
          path: ['publicBaseUrl'],
        })
      }
      if (o.authorizationServers.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'authorizationServers must include at least one issuer for external OAuth',
          path: ['authorizationServers'],
        })
      }
      for (const [index, server] of o.authorizationServers.entries()) {
        if (!server.issuer) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'issuer is required for external OAuth',
            path: ['authorizationServers', index, 'issuer'],
          })
        }
      }
      return
    }

    if (o.publicBaseUrl && !o.publicBaseUrl.startsWith('https://') && process.env['NODE_ENV'] === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'publicBaseUrl must use https:// in production',
        path: ['publicBaseUrl'],
      })
    }
  })

export type InboundOAuthConfig = z.infer<typeof InboundOAuthSchema>

export function isInboundOAuthConfigured(value: unknown): value is InboundOAuthConfig {
  return InboundOAuthSchema.safeParse(value).success
}
