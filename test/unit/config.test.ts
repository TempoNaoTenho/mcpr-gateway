import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, mergeWithAdminConfig, type AdminConfig } from '../../src/config/loader.js'
import { getConfig, initConfig } from '../../src/config/index.js'
import { GatewayMode } from '../../src/types/enums.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, '__tmp_config__')

const RESILIENCE = {
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

const SESSION = { ttlSeconds: 1800, cleanupIntervalSeconds: 60 } as const

const TRIGGERS = {
  refreshOnSuccess: false,
  refreshOnTimeout: true,
  refreshOnError: true,
  replaceOrAppend: 'replace' as const,
  cooldownSeconds: 30,
}

function validGatewayBase() {
  return {
    servers: [
      {
        id: 'test-server',
        namespaces: ['test'],
        transport: 'streamable-http' as const,
        url: 'https://example.com/mcp',
        enabled: true,
        trustLevel: 'internal' as const,
      },
    ],
    auth: { mode: 'static_key' as const },
    namespaces: {
      test: {
        allowedRoles: ['user'],
        bootstrapWindowSize: 4,
        candidatePoolSize: 16,
        allowedModes: ['read' as const],
      },
    },
    roles: {
      user: {
        allowNamespaces: ['test'],
        denyModes: ['admin' as const],
      },
    },
    selector: {
      lexical: { enabled: true },
      penalties: { write: 0.2, admin: 0.5, unhealthyDownstream: 0.7 },
    },
    session: SESSION,
    triggers: TRIGGERS,
    resilience: RESILIENCE,
    debug: { enabled: false },
    codeMode: {
      memoryLimitMb: 128,
      executionTimeoutMs: 10_000,
      maxToolCallsPerExecution: 20,
      maxResultSizeBytes: 1_048_576,
      artifactStoreTtlSeconds: 300,
      maxConcurrentToolCalls: 5,
    },
    starterPacks: {
      test: {
        preferredTags: ['search'],
        maxTools: 4,
        includeRiskLevels: ['low' as const],
        includeModes: ['read' as const],
      },
    },
    allowedOAuthProviders: [],
  }
}

function writeGatewayJson(dir: string, data: unknown): void {
  writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify(data, null, 2))
}

function writeValidConfig(): void {
  mkdirSync(TMP, { recursive: true })
  writeGatewayJson(TMP, validGatewayBase())
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('loadConfig — valid config', () => {
  it('merges legacy persisted admin config without an auth block', () => {
    const base = validGatewayBase()
    const adminConfig = {
      servers: base.servers,
      namespaces: base.namespaces,
      roles: base.roles,
      selector: base.selector,
      session: base.session,
      triggers: base.triggers,
      resilience: base.resilience,
      debug: base.debug,
      starterPacks: base.starterPacks,
    } as unknown as AdminConfig

    const merged = mergeWithAdminConfig({ auth: { mode: 'static_key' } }, adminConfig)

    expect(merged.auth).toEqual({ mode: 'static_key', staticKeys: undefined })
    expect(merged.servers).toEqual([
      {
        ...base.servers[0],
        healthcheck: {
          enabled: true,
          intervalSeconds: 30,
        },
      },
    ])
  })

  it('backfills missing healthchecks for legacy persisted servers', () => {
    const base = validGatewayBase()
    const adminConfig = {
      ...base,
      auth: {},
      servers: [
        {
          id: 'legacy-stdio',
          namespaces: ['test'],
          transport: 'stdio' as const,
          command: 'npx',
          args: ['-y', 'mcp-remote', 'https://example.com/mcp'],
          enabled: true,
          trustLevel: 'verified' as const,
        },
      ],
    } as unknown as AdminConfig

    const merged = mergeWithAdminConfig({ auth: { mode: 'static_key' } }, adminConfig)

    expect(merged.servers).toEqual([
      expect.objectContaining({
        id: 'legacy-stdio',
        healthcheck: {
          enabled: true,
          intervalSeconds: 30,
        },
      }),
    ])
  })

  it('backfills selector defaults for legacy persisted admin config', () => {
    const base = validGatewayBase()
    const adminConfig = {
      servers: base.servers,
      namespaces: base.namespaces,
      roles: base.roles,
      selector: {
        lexical: { enabled: false },
        penalties: { write: 0.2, admin: 0.5, unhealthyDownstream: 0.7 },
      },
      session: base.session,
      triggers: base.triggers,
      resilience: base.resilience,
      debug: base.debug,
      starterPacks: base.starterPacks,
    } as unknown as AdminConfig

    const merged = mergeWithAdminConfig({ auth: { mode: 'static_key' } }, adminConfig)

    expect(merged.selector.focus).toEqual({
      enabled: false,
      lookback: 5,
      minDominantSuccesses: 2,
      reserveSlots: 1,
      crossDomainPenalty: 1,
    })
    expect(merged.selector.publication).toEqual({
      descriptionCompression: 'off',
      schemaCompression: 'off',
      descriptionMaxLength: 160,
    })
  })

  it('accepts default as a namespace gateway mode', () => {
    const base = validGatewayBase()
    writeGatewayJson(TMP, {
      ...base,
      namespaces: {
        test: {
          ...base.namespaces.test,
          gatewayMode: GatewayMode.Default,
        },
      },
    })

    const loaded = loadConfig(TMP)
    expect(loaded.namespaces['test'].gatewayMode).toBe(GatewayMode.Default)
  })

  it('loads and returns a GatewayConfig without errors', () => {
    writeValidConfig()
    const config = loadConfig(TMP)
    expect(config.servers).toHaveLength(1)
    expect(config.servers[0].id).toBe('test-server')
    expect(config.namespaces['test']).toBeDefined()
    expect(config.roles['user']).toBeDefined()
    expect(config.selector.lexical.enabled).toBe(true)
    expect(config.starterPacks['test'].maxTools).toBe(4)
  })

  it('defaults auth to static_key when auth is omitted from bootstrap.json', () => {
    const base = validGatewayBase()
    const { auth: _a, ...withoutAuth } = base
    writeGatewayJson(TMP, withoutAuth)
    const config = loadConfig(TMP)
    expect(config.auth).toEqual({ mode: 'static_key' })
  })

  it('defaults debug.enabled to false when omitted', () => {
    const base = validGatewayBase()
    const { debug: _d, ...withoutDebug } = base
    writeGatewayJson(TMP, withoutDebug)
    const config = loadConfig(TMP)
    expect(config.debug).toEqual({ enabled: false })
  })

  it('defaults selector penalties when omitted', () => {
    writeGatewayJson(TMP, {
      ...validGatewayBase(),
      selector: {
        lexical: { enabled: false },
      },
    })
    const config = loadConfig(TMP)
    expect(config.selector.lexical.enabled).toBe(false)
    expect(config.selector.penalties).toEqual({
      write: 0,
      admin: 0.35,
      unhealthyDownstream: 0.5,
    })
  })

  it('loads debug.enabled when explicitly configured', () => {
    writeGatewayJson(TMP, {
      ...validGatewayBase(),
      debug: { enabled: true },
    })
    const config = loadConfig(TMP)
    expect(config.debug).toEqual({ enabled: true })
  })

  it('defaults disabledTools to empty when omitted from namespace policy', () => {
    writeValidConfig()
    const config = loadConfig(TMP)
    expect(config.namespaces['test'].disabledTools).toEqual([])
  })

  it('loads disabledTools when present on namespace policy', () => {
    const base = validGatewayBase()
    writeGatewayJson(TMP, {
      ...base,
      namespaces: {
        test: {
          ...base.namespaces.test,
          disabledTools: [{ serverId: 'test-server', name: 'noop' }],
        },
      },
    })
    const config = loadConfig(TMP)
    expect(config.namespaces['test'].disabledTools).toEqual([
      { serverId: 'test-server', name: 'noop' },
    ])
  })
})

describe('loadConfig — malformed JSON', () => {
  it('exits process on invalid JSON syntax', () => {
    writeValidConfig()
    writeFileSync(join(TMP, 'bootstrap.json'), '{ not json')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    expect(() => loadConfig(TMP)).toThrow('process.exit')
    exitSpy.mockRestore()
  })
})

describe('loadConfig — bootstrap defaults', () => {
  it('starts with built-in defaults when bootstrap.json is missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = loadConfig(TMP)

    expect(config.servers).toEqual([])
    expect(config.auth).toEqual({ mode: 'static_key' })
    expect(config.namespaces['default']).toBeDefined()
    expect(config.roles['user']).toEqual({
      allowNamespaces: ['default'],
      denyModes: ['admin'],
    })
    expect(config.selector.penalties).toEqual({
      write: 0,
      admin: 0.35,
      unhealthyDownstream: 0.5,
    })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('starting with built-in defaults and zero downstream servers')
    )

    warnSpy.mockRestore()
  })

  it('exits when a server references a namespace not defined in namespaces', () => {
    writeGatewayJson(TMP, {
      ...validGatewayBase(),
      servers: [
        {
          id: 'docs',
          namespaces: ['docs'],
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          enabled: true,
          trustLevel: 'internal',
        },
      ],
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    expect(() => loadConfig(TMP)).toThrow('process.exit')
    exitSpy.mockRestore()
  })

  it('loads zero downstream servers when servers array is empty in bootstrap.json', () => {
    writeGatewayJson(TMP, {
      ...validGatewayBase(),
      servers: [],
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = loadConfig(TMP)

    expect(config.servers).toEqual([])
    expect(config.namespaces['test']).toBeDefined()
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})

describe('loadConfig — invalid schema', () => {
  it('exits process when required server fields are missing', () => {
    writeValidConfig()
    writeGatewayJson(TMP, {
      ...validGatewayBase(),
      servers: [{ id: 'x', namespaces: ['y'] }],
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    expect(() => loadConfig(TMP)).toThrow('process.exit')
    exitSpy.mockRestore()
  })

  it('exits process when a namespace policy is invalid', () => {
    writeValidConfig()
    writeGatewayJson(TMP, {
      ...validGatewayBase(),
      namespaces: {
        test: {
          allowedRoles: ['user'],
          candidatePoolSize: 16,
          allowedModes: ['read'],
        },
      },
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    expect(() => loadConfig(TMP)).toThrow('process.exit')
    exitSpy.mockRestore()
  })

  it('loads when auth.mode is static_key without any staticKeys', () => {
    writeGatewayJson(TMP, {
      ...validGatewayBase(),
      auth: { mode: 'static_key' },
    })
    const config = loadConfig(TMP)
    expect(config.auth).toEqual({ mode: 'static_key' })
  })

  it('rejects legacy bootstrap auth.staticKeys', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    writeGatewayJson(TMP, {
      ...validGatewayBase(),
      auth: { mode: 'static_key', staticKeys: {} },
    })

    expect(() => loadConfig(TMP)).toThrow('process.exit')
    expect(errorSpy).toHaveBeenCalledWith('[config] Invalid bootstrap.json.auth:')
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('auth.staticKeys is no longer supported in bootstrap.json')
    )

    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('rejects legacy bootstrap auth.mode mock_dev', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    writeGatewayJson(TMP, {
      ...validGatewayBase(),
      auth: { mode: 'mock_dev' },
    })

    expect(() => loadConfig(TMP)).toThrow('process.exit')
    expect(errorSpy).toHaveBeenCalledWith('[config] Invalid bootstrap.json.auth:')
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('auth.mode "mock_dev" has been removed')
    )

    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

describe('loadConfig — starterPacks in bootstrap.json', () => {
  it('loads starterPacks from bootstrap.json', () => {
    writeValidConfig()
    const config = loadConfig(TMP)
    expect(config.starterPacks['test'].maxTools).toBe(4)
  })

  it('defaults starterPacks to empty object when section is absent', () => {
    const base = validGatewayBase()
    const { starterPacks: _s, ...withoutPacks } = base
    writeGatewayJson(TMP, withoutPacks)
    const config = loadConfig(TMP)
    expect(config.starterPacks).toEqual({})
  })
})

describe('loadConfig — cross-section validation', () => {
  it('exits when a server references an unknown namespace', () => {
    writeGatewayJson(TMP, {
      ...validGatewayBase(),
      servers: [
        {
          id: 'bad-server',
          namespaces: ['nonexistent'],
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          enabled: true,
          trustLevel: 'internal',
        },
      ],
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    expect(() => loadConfig(TMP)).toThrow('process.exit')
    exitSpy.mockRestore()
  })

  it('exits when a starterPack key references an unknown namespace', () => {
    writeGatewayJson(TMP, {
      ...validGatewayBase(),
      starterPacks: {
        nonexistent: {
          preferredTags: ['search'],
          maxTools: 4,
          includeRiskLevels: ['low'],
          includeModes: ['read'],
        },
      },
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    expect(() => loadConfig(TMP)).toThrow('process.exit')
    exitSpy.mockRestore()
  })

  it('loads without error when all references are valid', () => {
    writeValidConfig()
    const config = loadConfig(TMP)
    expect(config.starterPacks['test']).toBeDefined()
  })
})

describe('loadConfig — env var interpolation', () => {
  it('resolves ${VAR} placeholders from environment', () => {
    process.env['TEST_API_KEY'] = 'my-secret-token'
    writeGatewayJson(TMP, {
      ...validGatewayBase(),
      servers: [
        {
          ...validGatewayBase().servers[0],
          url: 'https://${TEST_API_KEY}.example.com/mcp',
        },
      ],
    })
    const config = loadConfig(TMP)
    expect(config.servers[0]?.url).toBe('https://my-secret-token.example.com/mcp')
    delete process.env['TEST_API_KEY']
  })

  it('exits when a referenced env var is not defined', () => {
    delete process.env['MISSING_VAR']
    writeFileSync(
      join(TMP, 'bootstrap.json'),
      JSON.stringify({
        ...validGatewayBase(),
        servers: [
          {
            ...validGatewayBase().servers[0],
            url: '${MISSING_VAR}',
          },
        ],
      })
    )
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    expect(() => loadConfig(TMP)).toThrow('process.exit')
    exitSpy.mockRestore()
  })

  it('passes through JSON without placeholders unchanged', () => {
    writeValidConfig()
    const config = loadConfig(TMP)
    expect(config.servers[0].id).toBe('test-server')
  })
})

describe('getConfig / initConfig', () => {
  it('throws descriptive error before initConfig is called', () => {
    expect(() => getConfig()).toThrow('Config not loaded — call initConfig() first')
  })

  it('initConfig loads and returns config, getConfig returns same instance', () => {
    writeValidConfig()
    const config = initConfig(TMP)
    expect(config.servers[0].id).toBe('test-server')
    expect(getConfig()).toBe(config)
  })
})
