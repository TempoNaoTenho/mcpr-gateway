import { z } from 'zod'

export const UserIdentitySchema = z.object({
  sub: z.string().min(1),
  roles: z.array(z.string()),
  metadata: z.record(z.unknown()).optional(),
})

export type UserIdentity = z.infer<typeof UserIdentitySchema>

export const SessionIdSchema = z.string().min(1).brand<'SessionId'>()

export type SessionId = z.infer<typeof SessionIdSchema>

export const NamespaceSchema = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Namespace must be lowercase alphanumeric with hyphens')
  .min(1)
  .max(64)

export type Namespace = z.infer<typeof NamespaceSchema>
