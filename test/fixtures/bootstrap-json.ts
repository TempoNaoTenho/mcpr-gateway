/** Shared fragments for valid `bootstrap.json` objects in tests */

export const defaultSelector = {
  lexical: { enabled: true },
  penalties: { write: 0.2, admin: 0.5, unhealthyDownstream: 0.7 },
  focus: {
    enabled: false,
    lookback: 5,
    minDominantSuccesses: 2,
    reserveSlots: 1,
    crossDomainPenalty: 1,
  },
  publication: {
    descriptionCompression: 'off' as const,
    schemaCompression: 'off' as const,
    descriptionMaxLength: 160,
  },
} as const

export const defaultSession = {
  ttlSeconds: 1800,
  cleanupIntervalSeconds: 60,
  handleTtlSeconds: 300,
} as const

export const defaultTriggers = {
  refreshOnSuccess: false,
  refreshOnTimeout: true,
  refreshOnError: true,
  replaceOrAppend: 'replace' as const,
  cooldownSeconds: 30,
}

export const defaultResilience = {
  timeouts: { connectMs: 5000, responseMs: 10000, totalMs: 30000 },
  rateLimit: {
    perSession: { maxRequests: 100, windowSeconds: 60 },
    perUser: { maxRequests: 500, windowSeconds: 60 },
    perDownstreamConcurrency: 10,
  },
  circuitBreaker: {
    degradedAfterFailures: 3,
    offlineAfterFailures: 5,
    resetAfterSeconds: 60,
  },
} as const

export const defaultDebug = { enabled: false }

export const defaultTestStaticKeys: Record<string, { userId: string; roles: string[] }> = {
  'alice:user': {
    userId: 'alice',
    roles: ['user'],
  },
  'bob:write-denied-user': {
    userId: 'bob',
    roles: ['write-denied-user'],
  },
  'alice:all': {
    userId: 'alice',
    roles: ['all'],
  },
  'benchmark:user': {
    userId: 'benchmark',
    roles: ['user'],
  },
}
