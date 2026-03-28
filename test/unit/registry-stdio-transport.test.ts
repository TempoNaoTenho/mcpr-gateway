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
    stdin: EventEmitter & {
      write: ReturnType<typeof vi.fn>
      destroyed?: boolean
      writableEnded?: boolean
    }
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>
    destroyed?: boolean
    writableEnded?: boolean
  }
  child.stdin.write = vi.fn((_: string, callback?: (error?: Error | null) => void) => {
    callback?.(null)
    return true
  })
  child.stdin.destroyed = false
  child.stdin.writableEnded = false
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

  it('turns stdin EPIPE into a rejected tools/call error instead of an unhandled exception', async () => {
    const child = createChild()
    child.stdin.write.mockImplementationOnce((_: string, callback?: (error?: Error | null) => void) => {
      const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      queueMicrotask(() => {
        callback?.(error)
        child.stdin.emit('error', error)
      })
      return false
    })
    spawnMock.mockReturnValue(child)

    const error = await callToolStdio(makeServer(), 'echo', {}).catch((err) => err)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('closed stdin before tools/call')
    expect((error as Error).message).toContain('write EPIPE')
  })
})
