import { describe, it, expect } from 'vitest'
import {
  SessionStatus,
  DownstreamHealth,
  ToolRiskLevel,
  SourceTrustLevel,
  OutcomeClass,
  RefreshTriggerType,
  Mode,
  GatewayError,
  GatewayErrorCode,
  UserIdentitySchema,
  SessionIdSchema,
  NamespaceSchema,
  DownstreamServerSchema,
  ServerConfigSchema,
  HealthStateSchema,
  ToolSchemaSchema,
  ToolRecordSchema,
  ToolcardSchema,
  VisibleToolSchema,
  SessionStateSchema,
  SelectorInputSchema,
  SelectorDecisionSchema,
  ExecutionOutcomeSchema,
  PolicyConfigSchema,
} from '../../src/types/index.js'

const NOW = new Date().toISOString()

describe('Enums', () => {
  it('SessionStatus has expected values', () => {
    expect(SessionStatus.Cold).toBe('cold')
    expect(SessionStatus.Active).toBe('active')
    expect(SessionStatus.Expired).toBe('expired')
    expect(SessionStatus.Revoked).toBe('revoked')
  })

  it('DownstreamHealth has expected values', () => {
    expect(DownstreamHealth.Unknown).toBe('unknown')
    expect(DownstreamHealth.Healthy).toBe('healthy')
    expect(DownstreamHealth.Degraded).toBe('degraded')
    expect(DownstreamHealth.Offline).toBe('offline')
  })

  it('Mode has expected values', () => {
    expect(Mode.Read).toBe('read')
    expect(Mode.Write).toBe('write')
    expect(Mode.Admin).toBe('admin')
  })
})

describe('GatewayError', () => {
  it('carries code and statusCode', () => {
    const err = new GatewayError(GatewayErrorCode.SESSION_NOT_FOUND)
    expect(err.code).toBe('SESSION_NOT_FOUND')
    expect(err.statusCode).toBe(404)
    expect(err.message).toBeTruthy()
    expect(err).toBeInstanceOf(Error)
  })

  it('accepts custom message and details', () => {
    const err = new GatewayError(GatewayErrorCode.INTERNAL_GATEWAY_ERROR, 'boom', { trace: 'x' })
    expect(err.message).toBe('boom')
    expect(err.statusCode).toBe(500)
    expect(err.details).toEqual({ trace: 'x' })
  })

  it('sets correct statusCodes for each code', () => {
    expect(new GatewayError(GatewayErrorCode.UNAUTHORIZED_NAMESPACE).statusCode).toBe(403)
    expect(new GatewayError(GatewayErrorCode.TOOL_NOT_VISIBLE).statusCode).toBe(404)
    expect(new GatewayError(GatewayErrorCode.DOWNSTREAM_UNAVAILABLE).statusCode).toBe(503)
    expect(new GatewayError(GatewayErrorCode.DOWNSTREAM_TIMEOUT).statusCode).toBe(504)
    expect(new GatewayError(GatewayErrorCode.INVALID_TOOL_ARGUMENTS).statusCode).toBe(400)
    expect(new GatewayError(GatewayErrorCode.UNSUPPORTED_OPERATION).statusCode).toBe(501)
  })
})

describe('UserIdentitySchema', () => {
  it('parses valid identity', () => {
    const result = UserIdentitySchema.parse({ sub: 'user-1', roles: ['admin'] })
    expect(result.sub).toBe('user-1')
    expect(result.roles).toEqual(['admin'])
  })

  it('accepts optional metadata', () => {
    const result = UserIdentitySchema.parse({ sub: 'u', roles: [], metadata: { org: 'acme' } })
    expect(result.metadata).toEqual({ org: 'acme' })
  })

  it('rejects empty sub', () => {
    expect(() => UserIdentitySchema.parse({ sub: '', roles: [] })).toThrow()
  })
})

describe('SessionIdSchema', () => {
  it('parses valid session id', () => {
    const id = SessionIdSchema.parse('abc123')
    expect(id).toBe('abc123')
  })

  it('rejects empty string', () => {
    expect(() => SessionIdSchema.parse('')).toThrow()
  })
})

describe('NamespaceSchema', () => {
  it('parses valid namespace', () => {
    expect(NamespaceSchema.parse('my-namespace')).toBe('my-namespace')
    expect(NamespaceSchema.parse('ns1')).toBe('ns1')
  })

  it('rejects namespace with uppercase', () => {
    expect(() => NamespaceSchema.parse('MyNamespace')).toThrow()
  })

  it('rejects namespace with invalid chars', () => {
    expect(() => NamespaceSchema.parse('ns_invalid')).toThrow()
    expect(() => NamespaceSchema.parse('ns invalid')).toThrow()
  })

  it('rejects namespace starting with hyphen', () => {
    expect(() => NamespaceSchema.parse('-bad')).toThrow()
  })
})

describe('DownstreamServerSchema', () => {
  const valid = {
    id: 'srv-1',
    namespaces: ['tools'],
    transport: 'streamable-http' as const,
    url: 'http://localhost:8080',
    enabled: true,
    trustLevel: SourceTrustLevel.Internal,
  }

  it('parses valid server config', () => {
    const result = DownstreamServerSchema.parse(valid)
    expect(result.id).toBe('srv-1')
    expect(result.transport).toBe('streamable-http')
  })

  it('accepts legacy namespace string via backward compat preprocess', () => {
    const result = DownstreamServerSchema.parse({
      id: 'x',
      namespace: 'tools',
      transport: 'streamable-http' as const,
      url: 'http://localhost',
      enabled: true,
      trustLevel: 'internal',
    })
    expect(result.namespaces).toEqual(['tools'])
  })

  it('normalizes empty namespaces to default (aligns with config loader)', () => {
    const result = DownstreamServerSchema.parse({ ...valid, namespaces: [] })
    expect(result.namespaces).toEqual(['default'])
  })

  it('accepts legacy http transport', () => {
    const result = DownstreamServerSchema.parse({ ...valid, transport: 'http' })
    expect(result.transport).toBe('http')
  })

  it('accepts headers for HTTP-based transports', () => {
    const result = DownstreamServerSchema.parse({
      ...valid,
      headers: {
        Authorization: 'Bearer token',
      },
    })
    expect(result.headers).toEqual({ Authorization: 'Bearer token' })
  })

  it('requires url for HTTP-based transports', () => {
    expect(() => DownstreamServerSchema.parse({ ...valid, url: undefined })).toThrow()
  })

  it('requires command for stdio transport', () => {
    expect(() =>
      DownstreamServerSchema.parse({
        ...valid,
        transport: 'stdio',
        url: undefined,
      }),
    ).toThrow()
  })

  it('parses stdio transport with command', () => {
    const result = DownstreamServerSchema.parse({
      ...valid,
      transport: 'stdio',
      url: undefined,
      command: 'node',
      args: ['dist/server.js'],
    })
    expect(result.transport).toBe('stdio')
    expect(result.command).toBe('node')
  })

  it('accepts stdio interactive auth only for stdio transport', () => {
    const result = DownstreamServerSchema.parse({
      ...valid,
      transport: 'stdio',
      url: undefined,
      command: 'node',
      stdioInteractiveAuth: { enabled: true },
    })
    expect(result.stdioInteractiveAuth).toEqual({ enabled: true })
  })

  it('rejects stdio interactive auth for HTTP-based transports', () => {
    expect(() =>
      DownstreamServerSchema.parse({
        ...valid,
        stdioInteractiveAuth: { enabled: true },
      }),
    ).toThrow('`stdioInteractiveAuth` is only supported when transport is `stdio`')
  })

  it('rejects headers for stdio transport', () => {
    expect(() =>
      DownstreamServerSchema.parse({
        ...valid,
        transport: 'stdio',
        url: undefined,
        command: 'node',
        headers: { Authorization: 'Bearer token' },
      }),
    ).toThrow('`headers` is not supported when transport is `stdio`')
  })

  it('rejects env for HTTP-based transports', () => {
    expect(() =>
      DownstreamServerSchema.parse({
        ...valid,
        env: { API_KEY: 'secret' },
      }),
    ).toThrow('`env` is only supported when transport is `stdio`')
  })

  it('rejects invalid transport', () => {
    expect(() => DownstreamServerSchema.parse({ ...valid, transport: 'grpc' })).toThrow()
  })

  it('accepts documented normal trust level and normalizes it', () => {
    const result = DownstreamServerSchema.parse({ ...valid, trustLevel: 'normal' })
    expect(result.trustLevel).toBe(SourceTrustLevel.Verified)
  })

  it('accepts documented high trust level and normalizes it', () => {
    const result = DownstreamServerSchema.parse({ ...valid, trustLevel: 'high' })
    expect(result.trustLevel).toBe(SourceTrustLevel.Internal)
  })

  it('rejects invalid trust level', () => {
    expect(() => DownstreamServerSchema.parse({ ...valid, trustLevel: 'superuser' })).toThrow()
  })
})

describe('HealthStateSchema', () => {
  it('parses valid health state', () => {
    const result = HealthStateSchema.parse({
      serverId: 'srv-1',
      status: DownstreamHealth.Healthy,
      lastChecked: NOW,
      latencyMs: 42,
    })
    expect(result.status).toBe('healthy')
    expect(result.latencyMs).toBe(42)
  })

  it('rejects negative latency', () => {
    expect(() =>
      HealthStateSchema.parse({
        serverId: 'srv-1',
        status: DownstreamHealth.Healthy,
        lastChecked: NOW,
        latencyMs: -1,
      }),
    ).toThrow()
  })
})

describe('ToolSchemaSchema', () => {
  it('parses valid tool schema', () => {
    const result = ToolSchemaSchema.parse({
      name: 'search',
      description: 'Search files',
      inputSchema: { type: 'object', properties: {} },
    })
    expect(result.name).toBe('search')
  })

  it('rejects empty name', () => {
    expect(() => ToolSchemaSchema.parse({ name: '', inputSchema: {} })).toThrow()
  })
})

describe('ToolRecordSchema', () => {
  it('parses valid tool record', () => {
    const result = ToolRecordSchema.parse({
      name: 'read_file',
      inputSchema: {},
      serverId: 'srv-1',
      namespace: 'files',
      retrievedAt: NOW,
      sanitized: true,
    })
    expect(result.sanitized).toBe(true)
  })
})

describe('ToolcardSchema', () => {
  it('parses valid toolcard', () => {
    const result = ToolcardSchema.parse({
      name: 'exec',
      inputSchema: {},
      serverId: 'srv-1',
      namespace: 'shell',
      retrievedAt: NOW,
      sanitized: false,
      riskLevel: ToolRiskLevel.High,
      tags: ['dangerous'],
      summary: 'Executes shell commands',
      sourceTrust: 'internal',
    })
    expect(result.riskLevel).toBe('high')
  })
})

describe('SessionStateSchema', () => {
  it('parses valid session state', () => {
    const result = SessionStateSchema.parse({
      id: 'sess-1',
      userId: 'user-1',
      namespace: 'main',
      mode: Mode.Read,
      status: SessionStatus.Active,
      toolWindow: [],
      createdAt: NOW,
      lastActiveAt: NOW,
      refreshCount: 0,
    })
    expect(result.status).toBe('active')
    expect(result.refreshCount).toBe(0)
  })

  it('rejects negative refreshCount', () => {
    expect(() =>
      SessionStateSchema.parse({
        id: 'sess-1',
        userId: 'user-1',
        namespace: 'main',
        mode: Mode.Read,
        status: SessionStatus.Active,
        toolWindow: [],
        createdAt: NOW,
        lastActiveAt: NOW,
        refreshCount: -1,
      }),
    ).toThrow()
  })
})

describe('SelectorDecisionSchema', () => {
  it('parses valid decision', () => {
    const result = SelectorDecisionSchema.parse({
      selected: [],
      triggeredBy: RefreshTriggerType.ExplicitRequest,
      timestamp: NOW,
    })
    expect(result.triggeredBy).toBe('explicit_request')
  })
})

describe('ExecutionOutcomeSchema', () => {
  it('parses valid outcome', () => {
    const result = ExecutionOutcomeSchema.parse({
      toolName: 'search',
      serverId: 'srv-1',
      sessionId: 'sess-1',
      outcome: OutcomeClass.Success,
      durationMs: 150,
      timestamp: NOW,
    })
    expect(result.outcome).toBe('success')
  })

  it('rejects negative duration', () => {
    expect(() =>
      ExecutionOutcomeSchema.parse({
        toolName: 'search',
        serverId: 'srv-1',
        sessionId: 'sess-1',
        outcome: OutcomeClass.Success,
        durationMs: -5,
        timestamp: NOW,
      }),
    ).toThrow()
  })
})

describe('PolicyConfigSchema', () => {
  it('parses valid policy', () => {
    const result = PolicyConfigSchema.parse({
      id: 'policy-1',
      namespaces: ['main'],
      roles: ['developer'],
      allow: [{ serverId: 'srv-1', tools: ['search', 'read'] }],
      selector: { strategy: 'relevance', maxTools: 10 },
    })
    expect(result.id).toBe('policy-1')
    expect(result.selector.maxTools).toBe(10)
  })

  it('rejects zero maxTools', () => {
    expect(() =>
      PolicyConfigSchema.parse({
        id: 'p',
        namespaces: ['ns'],
        roles: [],
        allow: [],
        selector: { strategy: 'x', maxTools: 0 },
      }),
    ).toThrow()
  })
})
