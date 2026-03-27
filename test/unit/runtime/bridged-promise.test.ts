import { describe, expect, it } from 'vitest'
import { trackBridgedPromise } from '../../../src/runtime/sandbox.js'

describe('trackBridgedPromise', () => {
  it('cleans up rejected bridged promises without leaving pending state', async () => {
    const pending = new Map<Promise<unknown>, 'mcp.call'>()
    const bridged = trackBridgedPromise(
      pending,
      'mcp.call',
      new Promise<unknown>((_resolve, reject) => {
        setTimeout(() => reject(new Error('downstream failed')), 0)
      }),
    )

    await expect(bridged).rejects.toThrow('downstream failed')
    await Promise.resolve()

    expect(pending.size).toBe(0)
  })

  it('reports timeout diagnostics with operation metadata', async () => {
    const pending = new Map<Promise<unknown>, 'mcp.call'>()
    const events: Array<Record<string, unknown>> = []

    const bridged = trackBridgedPromise(
      pending,
      'mcp.call',
      new Promise<unknown>(() => undefined),
      {
        onDiagnosticEvent: (event) => {
          events.push(event as unknown as Record<string, unknown>)
        },
      },
      25
    )

    await expect(bridged).rejects.toThrow('Bridge operation mcp.call timed out after 25ms')
    await Promise.resolve()

    expect(events[0]).toMatchObject({
      type: 'bridge_start',
      operation: 'mcp.call',
      timeoutMs: 25,
    })
    expect(events[1]).toMatchObject({
      type: 'bridge_settled',
      operation: 'mcp.call',
      outcome: 'timed_out',
      normalized: false,
      truncated: false,
    })
  })
})
