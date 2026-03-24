import { z } from 'zod'
import { DownstreamServerSchema } from '../types/server.js'
import { GatewayMode, Mode, ToolRiskLevel } from '../types/enums.js'

// --- bootstrap.json (servers + policies in one file) ---

export const ServersFileSchema = z.object({
  servers: z.array(DownstreamServerSchema),
})

export type ServersFile = z.infer<typeof ServersFileSchema>

// --- Policy sections (embedded in bootstrap.json under the same keys) ---

const DisabledToolRefSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
})

const NamespacePolicySchema = z.object({
  allowedRoles: z.array(z.string().min(1)),
  bootstrapWindowSize: z.number().int().positive(),
  candidatePoolSize: z.number().int().positive(),
  allowedModes: z.array(z.nativeEnum(Mode)),
  gatewayMode: z.nativeEnum(GatewayMode).default(GatewayMode.Compat),
  disabledTools: z.array(DisabledToolRefSchema).default([]),
})

const RolePolicySchema = z.object({
  allowNamespaces: z.array(z.string().min(1)),
  denyModes: z.array(z.nativeEnum(Mode)).optional(),
})

const SelectorLexicalSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .strict()

const SelectorVectorSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict()

const SelectorPenaltySchema = z.object({
  write: z.number().min(0).max(1).default(0.15),
  admin: z.number().min(0).max(1).default(0.35),
  unhealthyDownstream: z.number().min(0).max(1).default(0.5),
})

const SelectorFocusSchema = z
  .object({
    enabled: z.boolean().default(true),
    lookback: z.number().int().positive().default(5),
    minDominantSuccesses: z.number().int().positive().default(2),
    reserveSlots: z.number().int().nonnegative().default(1),
    crossDomainPenalty: z.number().min(0).max(5).default(1),
  })
  .strict()

const SelectorPublicationSchema = z
  .object({
    descriptionCompression: z.enum(['off', 'conservative']).default('conservative'),
    schemaCompression: z.enum(['off', 'conservative']).default('conservative'),
    descriptionMaxLength: z.number().int().positive().default(160),
  })
  .strict()

const SelectorDiscoveryToolSchema = z.object({
  enabled: z.boolean().default(false),
  resultLimit: z.number().int().positive().default(8),
  promoteCount: z.number().int().positive().default(3),
})

const SelectorConfigSchema = z
  .object({
    lexical: SelectorLexicalSchema.default({}),
    vector: SelectorVectorSchema.default({}),
    penalties: SelectorPenaltySchema.default({}),
    focus: SelectorFocusSchema.default({}),
    publication: SelectorPublicationSchema.default({}),
    discoveryTool: SelectorDiscoveryToolSchema.default({}),
  })
  .strict()

export type SelectorConfig = z.infer<typeof SelectorConfigSchema>

const AuthStaticKeyEntrySchema = z.object({
  userId: z.string().min(1),
  roles: z.array(z.string().min(1)),
})

const AuthStaticKeysSchema = z.record(z.string().min(1), AuthStaticKeyEntrySchema)

export const AuthConfigSchema = z.object({
  mode: z.enum(['static_key', 'mock_dev']),
  staticKeys: AuthStaticKeysSchema.optional(),
})

export type AuthConfig = z.infer<typeof AuthConfigSchema>

export const SessionConfigSchema = z.object({
  ttlSeconds: z.number().int().nonnegative().default(1800),
  cleanupIntervalSeconds: z.number().int().positive().default(60),
  handleTtlSeconds: z.number().int().positive().default(300),
})

export type SessionConfig = z.infer<typeof SessionConfigSchema>

export const TriggerPolicySchema = z.object({
  refreshOnSuccess: z.boolean().default(false),
  refreshOnTimeout: z.boolean().default(true),
  refreshOnError: z.boolean().default(true),
  replaceOrAppend: z.enum(['replace', 'append']).default('replace'),
  cooldownSeconds: z.number().int().nonnegative().default(30),
})

export type TriggerPolicy = z.infer<typeof TriggerPolicySchema>

export const ResilienceConfigSchema = z
  .object({
    timeouts: z
      .object({
        connectMs: z.number().int().positive().default(5000),
        responseMs: z.number().int().positive().default(10000),
        totalMs: z.number().int().positive().default(30000),
      })
      .default({}),
    rateLimit: z
      .object({
        perSession: z
          .object({
            maxRequests: z.number().int().positive().default(100),
            windowSeconds: z.number().int().positive().default(60),
          })
          .default({}),
        perUser: z
          .object({
            maxRequests: z.number().int().positive().default(500),
            windowSeconds: z.number().int().positive().default(60),
          })
          .default({}),
        perDownstreamConcurrency: z.number().int().positive().default(10),
      })
      .default({}),
    circuitBreaker: z
      .object({
        degradedAfterFailures: z.number().int().positive().default(3),
        offlineAfterFailures: z.number().int().positive().default(5),
        resetAfterSeconds: z.number().int().positive().default(60),
      })
      .default({}),
  })
  .default({})

export type ResilienceConfig = z.infer<typeof ResilienceConfigSchema>

export const DebugConfigSchema = z.object({
  enabled: z.boolean().default(false),
})

export type DebugConfig = z.infer<typeof DebugConfigSchema>

export const CodeModeConfigSchema = z.object({
  memoryLimitMb: z.number().int().positive().default(128),
  executionTimeoutMs: z.number().int().positive().default(10_000),
  maxToolCallsPerExecution: z.number().int().positive().default(20),
  maxResultSizeBytes: z.number().int().positive().default(1_048_576),
  artifactStoreTtlSeconds: z.number().int().positive().default(300),
  maxConcurrentToolCalls: z.number().int().positive().default(5),
})

export type CodeModeConfig = z.infer<typeof CodeModeConfigSchema>

// --- starter-packs (embedded in bootstrap.json as `starterPacks`) ---

const StarterPackSchema = z.object({
  preferredTags: z.array(z.string().min(1)),
  maxTools: z.number().int().positive(),
  includeRiskLevels: z.array(z.nativeEnum(ToolRiskLevel)),
  includeModes: z.array(z.nativeEnum(Mode)),
})

export const StarterPacksFileSchema = z.object({
  starterPacks: z.record(z.string().min(1), StarterPackSchema),
})

export type StarterPacksFile = z.infer<typeof StarterPacksFileSchema>

export const PoliciesFileSchema = z.object({
  auth: AuthConfigSchema.default({ mode: 'mock_dev' }),
  namespaces: z.record(z.string().min(1), NamespacePolicySchema),
  roles: z.record(z.string().min(1), RolePolicySchema),
  selector: SelectorConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  triggers: TriggerPolicySchema.default({}),
  resilience: ResilienceConfigSchema,
  debug: DebugConfigSchema.default({}),
  codeMode: CodeModeConfigSchema.default({}),
  starterPacks: z.record(z.string().min(1), StarterPackSchema).default({}),
})

export type PoliciesFile = z.infer<typeof PoliciesFileSchema>

/** Full on-disk config: downstream servers plus auth, policies, and tuning. */
export const GatewayConfigFileSchema = z.object({
  servers: z.array(DownstreamServerSchema).default([]),
  auth: AuthConfigSchema.default({ mode: 'mock_dev' }),
  namespaces: z.record(z.string().min(1), NamespacePolicySchema).default({}),
  roles: z.record(z.string().min(1), RolePolicySchema).default({}),
  selector: SelectorConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  triggers: TriggerPolicySchema.default({}),
  resilience: ResilienceConfigSchema.default({}),
  debug: DebugConfigSchema.default({}),
  codeMode: CodeModeConfigSchema.default({}),
  starterPacks: z.record(z.string().min(1), StarterPackSchema).default({}),
  allowedOAuthProviders: z.array(z.string()).default([]),
})

export type GatewayConfigFile = z.infer<typeof GatewayConfigFileSchema>
