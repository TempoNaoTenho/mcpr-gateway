import { z } from 'zod'

export const IssuerConfigSchema = z.object({
  issuer: z.string().url(),
  audience: z.string().min(1).optional(),
  jwksUri: z.string().url().optional(),
  rolesClaim: z.string().min(1).default('roles'),
})

export type IssuerConfig = z.infer<typeof IssuerConfigSchema>

export const InboundOAuthSchema = z
  .object({
    publicBaseUrl: z.string().url(),
    authorizationServers: z.array(IssuerConfigSchema).min(1),
    requireForNamespaces: z.array(z.string().min(1)).optional(),
    scopesSupported: z.array(z.string().min(1)).optional(),
    /** Origins allowed for browser MCP clients (e.g. https://chatgpt.com). Empty = loopback-only CORS behavior. */
    allowedBrowserOrigins: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (o) =>
      o.publicBaseUrl.startsWith('https://') ||
      process.env['NODE_ENV'] !== 'production',
    {
      message: 'publicBaseUrl must use https:// in production',
      path: ['publicBaseUrl'],
    },
  )

export type InboundOAuthConfig = z.infer<typeof InboundOAuthSchema>
