import { describe, it, expect, vi, afterEach } from 'vitest'
import { HealthMonitor } from '../../src/health/monitor.js'
import { SourceTrustLevel } from '../../src/types/enums.js'
import type { DownstreamServer } from '../../src/types/server.js'

vi.mock('../../src/registry/transport/http.js', () => ({
  postJsonRpc: vi.fn(),
}))

import { postJsonRpc } from '../../src/registry/transport/http.js'

const makeServer = (overrides: Partial<DownstreamServer> = {}): DownstreamServer => ({
  id: 'fast-mcp-docs',
  namespaces: ['default'],
  transport: 'streamable-http',
  url: 'https://example.com/mcp',
  enabled: true,
  trustLevel: SourceTrustLevel.Verified,
  healthcheck: {
    enabled: true,
    intervalSeconds: 30,
  },
  ...overrides,
})

describe('HealthMonitor.start()', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('runs an immediate health probe for enabled servers', async () => {
    vi.mocked(postJsonRpc).mockResolvedValue({
      body: { result: { protocolVersion: '2024-11-05' } },
      sessionId: undefined,
    })

    const monitor = new HealthMonitor()
    monitor.start([makeServer()], {
      degradedAfterFailures: 3,
      offlineAfterFailures: 5,
      resetAfterSeconds: 60,
    })

    await vi.waitFor(() => {
      expect(monitor.getState('fast-mcp-docs')).toMatchObject({
        status: 'healthy',
        error: undefined,
      })
    })

    monitor.stop()
  })
})
