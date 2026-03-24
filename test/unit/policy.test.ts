import { describe, it, expect } from 'vitest'
import { resolvePolicy } from '../../src/policy/resolver.js'
import { GatewayErrorCode } from '../../src/types/errors.js'
import { Mode } from '../../src/types/enums.js'
import type { GatewayConfig } from '../../src/config/loader.js'
import type { UserIdentity } from '../../src/types/identity.js'

// Minimal config covering all policy resolution scenarios
function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    servers: [],
    auth: { mode: 'mock_dev' },
    namespaces: {
      gmail: {
        allowedRoles: ['user', 'admin'],
        bootstrapWindowSize: 4,
        candidatePoolSize: 16,
        allowedModes: [Mode.Read, Mode.Write],
      },
      readonly: {
        allowedRoles: ['user'],
        bootstrapWindowSize: 4,
        candidatePoolSize: 16,
        allowedModes: [Mode.Read],
      },
    },
    roles: {
      user: {
        allowNamespaces: ['gmail', 'readonly'],
        denyModes: [Mode.Admin],
      },
      admin: {
        allowNamespaces: ['gmail'],
        denyModes: [],
      },
      restricted: {
        allowNamespaces: [],
        denyModes: [Mode.Write, Mode.Admin],
      },
    },
    selector: {
      lexical: { enabled: true },
      vector: { enabled: false },
      penalties: { write: 0.2, admin: 0.5, unhealthyDownstream: 0.7 },
    },
    session: { ttlSeconds: 1800, cleanupIntervalSeconds: 60 },
    triggers: {
      refreshOnSuccess: false,
      refreshOnTimeout: true,
      refreshOnError: true,
      replaceOrAppend: 'replace',
      cooldownSeconds: 30,
    },
    resilience: {
      timeouts: { connectMs: 5000, responseMs: 10000, totalMs: 30000 },
      rateLimit: {
        perSession: { maxRequests: 100, windowSeconds: 60 },
        perUser: { maxRequests: 500, windowSeconds: 60 },
        perDownstreamConcurrency: 10,
      },
      circuitBreaker: { degradedAfterFailures: 3, offlineAfterFailures: 5, resetAfterSeconds: 60 },
    },
    debug: { enabled: false },
    starterPacks: {},
    ...overrides,
  } as unknown as GatewayConfig
}

function makeIdentity(sub: string, roles: string[]): UserIdentity {
  return { sub, roles }
}

describe('resolvePolicy — allowed scenarios', () => {
  it('allows user with role in allowedRoles and allowNamespaces', () => {
    const config = makeConfig()
    const identity = makeIdentity('alice', ['user'])
    const decision = resolvePolicy(identity, 'gmail', Mode.Read, config)

    expect(decision.allowed).toBe(true)
    expect(decision.rejectionCode).toBeUndefined()
    expect(decision.starterPackKey).toBe('gmail')
    expect(decision.namespacePolicy).toBeDefined()
    expect(decision.namespacePolicy?.bootstrapWindowSize).toBe(4)
  })

  it('allows admin with access to gmail namespace', () => {
    const config = makeConfig()
    const identity = makeIdentity('bob', ['admin'])
    const decision = resolvePolicy(identity, 'gmail', Mode.Write, config)

    expect(decision.allowed).toBe(true)
    expect(decision.starterPackKey).toBe('gmail')
  })

  it('allows user with multiple roles when at least one grants access', () => {
    const config = makeConfig()
    const identity = makeIdentity('carol', ['restricted', 'user'])
    const decision = resolvePolicy(identity, 'gmail', Mode.Read, config)

    expect(decision.allowed).toBe(true)
  })

  it('returns namespacePolicy with correct window sizes', () => {
    const config = makeConfig()
    const identity = makeIdentity('alice', ['user'])
    const decision = resolvePolicy(identity, 'gmail', Mode.Read, config)

    expect(decision.allowed).toBe(true)
    expect(decision.namespacePolicy?.bootstrapWindowSize).toBe(4)
    expect(decision.namespacePolicy?.candidatePoolSize).toBe(16)
  })
})

describe('resolvePolicy — namespace not found', () => {
  it('rejects unknown namespace', () => {
    const config = makeConfig()
    const identity = makeIdentity('alice', ['user'])
    const decision = resolvePolicy(identity, 'nonexistent', Mode.Read, config)

    expect(decision.allowed).toBe(false)
    expect(decision.rejectionCode).toBe(GatewayErrorCode.UNAUTHORIZED_NAMESPACE)
  })
})

describe('resolvePolicy — role not in namespace allowedRoles', () => {
  it('rejects when user role is not listed in namespace allowedRoles', () => {
    const config = makeConfig()
    // 'restricted' role is not in gmail.allowedRoles
    const identity = makeIdentity('alice', ['restricted'])
    const decision = resolvePolicy(identity, 'gmail', Mode.Read, config)

    expect(decision.allowed).toBe(false)
    expect(decision.rejectionCode).toBe(GatewayErrorCode.UNAUTHORIZED_NAMESPACE)
  })
})

describe('resolvePolicy — role allowNamespaces does not include namespace', () => {
  it('rejects when role allowNamespaces excludes the requested namespace', () => {
    const config = makeConfig()
    // admin role does not have 'readonly' in allowNamespaces
    const identity = makeIdentity('bob', ['admin'])
    const decision = resolvePolicy(identity, 'readonly', Mode.Read, config)

    expect(decision.allowed).toBe(false)
    expect(decision.rejectionCode).toBe(GatewayErrorCode.UNAUTHORIZED_NAMESPACE)
  })
})

describe('resolvePolicy — mode not in namespace allowedModes', () => {
  it('rejects when requested mode is not in namespace allowedModes', () => {
    const config = makeConfig()
    // 'readonly' namespace only allows Mode.Read, not Mode.Write
    const identity = makeIdentity('alice', ['user'])
    const decision = resolvePolicy(identity, 'readonly', Mode.Write, config)

    expect(decision.allowed).toBe(false)
    expect(decision.rejectionCode).toBe(GatewayErrorCode.UNAUTHORIZED_NAMESPACE)
  })

  it('rejects admin mode even for user with role access', () => {
    const config = makeConfig()
    const identity = makeIdentity('alice', ['user'])
    // gmail.allowedModes = [read, write] — doesn't include admin
    const decision = resolvePolicy(identity, 'gmail', Mode.Admin, config)

    expect(decision.allowed).toBe(false)
    expect(decision.rejectionCode).toBe(GatewayErrorCode.UNAUTHORIZED_NAMESPACE)
  })
})

describe('resolvePolicy — mode denied by role denyModes', () => {
  it('rejects when requested mode is in role denyModes', () => {
    const config = makeConfig()
    // user role has denyModes: [admin]
    // but admin is not in gmail.allowedModes anyway, so test with a config where it is
    const configWithAdminAllowed = makeConfig({
      namespaces: {
        gmail: {
          allowedRoles: ['user'],
          bootstrapWindowSize: 4,
          candidatePoolSize: 16,
          allowedModes: [Mode.Read, Mode.Write, Mode.Admin],
        },
      },
    })
    const identity = makeIdentity('alice', ['user'])
    const decision = resolvePolicy(identity, 'gmail', Mode.Admin, configWithAdminAllowed)

    expect(decision.allowed).toBe(false)
    expect(decision.rejectionCode).toBe(GatewayErrorCode.UNAUTHORIZED_NAMESPACE)
  })

  it('rejects write mode for role with denyModes including write', () => {
    const configWithWriteDeny = makeConfig({
      roles: {
        user: {
          allowNamespaces: ['gmail'],
          denyModes: [Mode.Write],
        },
      },
    })
    const identity = makeIdentity('alice', ['user'])
    const decision = resolvePolicy(identity, 'gmail', Mode.Write, configWithWriteDeny)

    expect(decision.allowed).toBe(false)
    expect(decision.rejectionCode).toBe(GatewayErrorCode.UNAUTHORIZED_NAMESPACE)
  })

  it('allows read mode even when write is denied', () => {
    const configWithWriteDeny = makeConfig({
      roles: {
        user: {
          allowNamespaces: ['gmail'],
          denyModes: [Mode.Write],
        },
      },
    })
    const identity = makeIdentity('alice', ['user'])
    const decision = resolvePolicy(identity, 'gmail', Mode.Read, configWithWriteDeny)

    expect(decision.allowed).toBe(true)
  })
})
