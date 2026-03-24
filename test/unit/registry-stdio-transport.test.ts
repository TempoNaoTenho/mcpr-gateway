import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { callToolStdio, fetchToolsStdio } from '../../src/registry/transport/stdio.js'
import type { DownstreamServer } from '../../src/types/server.js'
import { SourceTrustLevel } from '../../src/types/enums.js'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

function makeServer(overrides: Partial<DownstreamServer> = {}): DownstreamServer {
  return {
    id: 'stdio-server',
    namespaces: ['default'],
    transport: 'stdio',
    command: 'npx',
    args: ['example-server'],
    enabled: true,
    trustLevel: SourceTrustLevel.Verified,
    ...overrides,
  }
}

function createChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: vi.fn() }
  child.kill = vi.fn()
  return child
}

describe('stdio transport', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses stdioTimeoutSeconds for tools/list and surfaces interactive auth hints from stderr', async () => {
    vi.useFakeTimers()
    const child = createChild()
    spawnMock.mockReturnValue(child)

    const pending = fetchToolsStdio(makeServer({ stdioTimeoutSeconds: 1 }))
    const handled = pending.catch((error) => error)
    child.stderr.emit('data', Buffer.from('Open http://localhost:22393/oauth/callback in your browser\n'))

    await vi.advanceTimersByTimeAsync(1000)

    const error = await handled
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('timed out after 1000ms')
    expect((error as Error).message).toContain(
      'the process appears to be waiting for local browser or device authentication',
    )
  })

  it('uses stdioTimeoutSeconds for tools/call timeouts', async () => {
    vi.useFakeTimers()
    const child = createChild()
    spawnMock.mockReturnValue(child)

    const pending = callToolStdio(makeServer({ stdioTimeoutSeconds: 2 }), 'echo', {})
    const handled = pending.catch((error) => error)

    await vi.advanceTimersByTimeAsync(2000)

    const error = await handled
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('timed out after 2000ms')
  })
})
