import { afterEach, describe, expect, it, vi } from 'vitest'
import { HealthMonitor } from '../../src/health/monitor.js'
import { DownstreamHealth, SourceTrustLevel } from '../../src/types/enums.js'
import type { DownstreamServer } from '../../src/types/server.js'

vi.mock('../../src/registry/transport/http.js', () => ({
  postJsonRpc: vi.fn(),
}))

import { postJsonRpc } from '../../src/registry/transport/http.js'

function makeServer(): DownstreamServer {
  return {
    id: 'gmail-server',
    namespaces: ['gmail'],
    transport: 'http',
    url: 'https://example.com/mcp',
    enabled: true,
    trustLevel: SourceTrustLevel.Internal,
    healthcheck: {
      enabled: true,
      intervalSeconds: 5,
    },
  }
}

describe('HealthMonitor.check()', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps an offline server offline until resetAfterSeconds elapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-17T20:00:00.000Z'))

    const monitor = new HealthMonitor()
    monitor.start([makeServer()], {
      degradedAfterFailures: 1,
      offlineAfterFailures: 1,
      resetAfterSeconds: 60,
    })

    vi.mocked(postJsonRpc).mockRejectedValueOnce(new Error('downstream unavailable'))
    const first = await monitor.check('gmail-server')
    expect(first.status).toBe(DownstreamHealth.Offline)

    vi.mocked(postJsonRpc).mockResolvedValueOnce({ body: { result: {} }, sessionId: 'session-1' })
    vi.setSystemTime(new Date('2026-03-17T20:00:30.000Z'))
    const second = await monitor.check('gmail-server')
    expect(second.status).toBe(DownstreamHealth.Offline)

    vi.mocked(postJsonRpc).mockResolvedValueOnce({ body: { result: {} }, sessionId: 'session-1' })
    vi.setSystemTime(new Date('2026-03-17T20:01:01.000Z'))
    const third = await monitor.check('gmail-server')
    expect(third.status).toBe(DownstreamHealth.Healthy)

    monitor.stop()
  })
})
