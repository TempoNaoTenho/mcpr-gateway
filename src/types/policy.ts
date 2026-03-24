import { z } from 'zod'

export const PolicyConfigSchema = z.object({
  id: z.string().min(1),
  namespaces: z.array(z.string().min(1)),
  roles: z.array(z.string()),
  allow: z.array(
    z.object({
      serverId: z.string().min(1),
      tools: z.array(z.string()),
    }),
  ),
  selector: z.object({
    strategy: z.string().min(1),
    maxTools: z.number().int().positive(),
    penalties: z
      .record(
        z.object({
          score: z.number(),
          reason: z.string().optional(),
        }),
      )
      .optional(),
  }),
})

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>
