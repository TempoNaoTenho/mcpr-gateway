import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initConfig, setConfig } from '../../src/config/index.js'
import { runStdioMcp } from '../../src/gateway/stdio-mcp.js'
import { MemorySessionStore } from '../../src/session/store.js'
import { GatewayMode, Mode } from '../../src/types/enums.js'
import {
  defaultDebug,
  defaultResilience,
  defaultSelector,
  defaultSession,
  defaultTriggers,
} from '../fixtures/bootstrap-json.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, '__tmp_stdio_mcp__')

beforeAll(() => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(
    join(TMP, 'bootstrap.json'),
    JSON.stringify(
      {
        servers: [],
        auth: { mode: 'static_key' },
        namespaces: {
          default: {
            allowedRoles: ['user'],
            bootstrapWindowSize: 4,
            candidatePoolSize: 16,
            allowedModes: [Mode.Read],
            gatewayMode: GatewayMode.Default,
          },
        },
        roles: {
          user: { allowNamespaces: ['default'] },
        },
        selector: defaultSelector,
        session: defaultSession,
        triggers: defaultTriggers,
        resilience: defaultResilience,
        debug: defaultDebug,
        starterPacks: {},
      },
      null,
      2,
    ),
  )
  const config = initConfig(TMP)
  setConfig({
    ...config,
    auth: {
      ...config.auth,
      staticKeys: {
        'stdio:secret': { userId: 'stdio-user', roles: ['user'] },
      },
    },
  })
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

function makeRegistry() {
  return {
    getToolsByNamespace() {
      return [] as { server: unknown; records: unknown[] }[]
    },
    getHealthStates() {
      return {}
    },
  }
}

async function nextLine(rl: ReturnType<typeof createInterface>): Promise<string> {
  return await new Promise((resolve, reject) => {
    const onLine = (line: string): void => {
      rl.off('line', onLine)
      rl.off('close', onClose)
      resolve(line)
    }
    const onClose = (): void => {
      rl.off('line', onLine)
      reject(new Error('stream closed before line'))
    }
    rl.once('line', onLine)
    rl.once('close', onClose)
  })
}

describe('runStdioMcp', () => {
  it('completes initialize then tools/list without Mcp-Session-Id headers', async () => {
    const store = new MemorySessionStore()
    store.start(3600, 60)

    const input = new PassThrough()
    const output = new PassThrough()
    const outRl = createInterface({ input: output })

    const p = runStdioMcp({
      store,
      registry: makeRegistry() as never,
      triggerEngine: { evaluate: vi.fn().mockResolvedValue(undefined) } as never,
      namespace: 'default',
      authorization: 'Bearer stdio:secret',
      stdin: input,
      stdout: output,
    })

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      })}\n`,
    )

    const initLine = await nextLine(outRl)
    const initMsg = JSON.parse(initLine) as {
      jsonrpc: string
      id: number
      result: { protocolVersion: string }
    }
    expect(initMsg.jsonrpc).toBe('2.0')
    expect(initMsg.id).toBe(1)
    expect(initMsg.result.protocolVersion).toBe('2024-11-05')

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      })}\n`,
    )

    const listLine = await nextLine(outRl)
    const listMsg = JSON.parse(listLine) as {
      jsonrpc: string
      id: number
      result: { tools: unknown[] }
    }
    expect(listMsg.jsonrpc).toBe('2.0')
    expect(listMsg.id).toBe(2)
    expect(Array.isArray(listMsg.result.tools)).toBe(true)

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      })}\n`,
    )

    input.end()
    await p
    outRl.close()
  })

  it('returns JSON-RPC error for tools/list before initialize', async () => {
    const store = new MemorySessionStore()
    store.start(3600, 60)
    const input = new PassThrough()
    const output = new PassThrough()
    const outRl = createInterface({ input: output })

    const p = runStdioMcp({
      store,
      registry: makeRegistry() as never,
      triggerEngine: { evaluate: vi.fn() } as never,
      namespace: 'default',
      authorization: 'Bearer stdio:secret',
      stdin: input,
      stdout: output,
    })

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/list',
        params: {},
      })}\n`,
    )

    const line = await nextLine(outRl)
    const msg = JSON.parse(line) as { error?: { message?: string }; id: number }
    expect(msg.id).toBe(9)
    expect(msg.error).toBeDefined()

    input.end()
    await p
    outRl.close()
  })
})
