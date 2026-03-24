import { z } from 'zod'

/**
 * Schema for validating OAuth provider URLs.
 * - Must be a valid URL
 * - Must use HTTPS protocol (prevents SSRF)
 * - Can include path patterns like https://auth.example.com/*
 */
export const OAuthProviderUrlSchema = z
  .string()
  .url()
  .refine(
    (url) => {
      try {
        const parsed = new URL(url)
        return parsed.protocol === 'https:'
      } catch {
        return false
      }
    },
    { message: 'OAuth provider URL must use HTTPS protocol' }
  )

export type OAuthProviderUrl = z.infer<typeof OAuthProviderUrlSchema>

/**
 * Schema for a single command in the allowlist.
 * - command: string (required) - can be basename (e.g., "node") or absolute path (e.g., "/usr/bin/node")
 * - args: optional array of strings
 */
const CommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
})

/**
 * Schema for validating command allowlist configuration.
 * - Array of command objects
 * - Each command has: command (required string), args (optional array of strings)
 */
export const CommandAllowlistSchema = z.array(CommandSchema)

export type CommandAllowlist = z.infer<typeof CommandAllowlistSchema>
