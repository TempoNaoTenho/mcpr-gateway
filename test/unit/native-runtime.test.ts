import { describe, expect, it, vi } from 'vitest'

import { ensureNativeRuntimeReady } from '../../scripts/native-runtime.mjs'

describe('native runtime preflight', () => {
  it('returns immediately when native modules are already healthy', () => {
    const inspect = vi.fn(() => ({ ok: true, needsRebuild: false, failedModules: [] }))
    const run = vi.fn()

    const result = ensureNativeRuntimeReady({ cwd: '/tmp/project', inspect, run })

    expect(result).toEqual({
      rebuilt: false,
      failedModules: [],
      message: `Native modules are ready for Node ${process.versions.node}.`,
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('rebuilds once when the ABI no longer matches the active Node version', () => {
    const inspect = vi
      .fn()
      .mockReturnValueOnce({
        ok: false,
        needsRebuild: true,
        failedModules: ['better-sqlite3'],
        message: 'Native modules need rebuild for Node 24.14.1: better-sqlite3',
      })
      .mockReturnValueOnce({
        ok: true,
        needsRebuild: false,
        failedModules: [],
      })
    const run = vi.fn()

    const result = ensureNativeRuntimeReady({ cwd: '/tmp/project', inspect, run })

    expect(run).toHaveBeenCalledWith(['rebuild', 'isolated-vm', 'better-sqlite3'], '/tmp/project')
    expect(result.rebuilt).toBe(true)
    expect(result.failedModules).toEqual(['better-sqlite3'])
  })

  it('fails fast on non-ABI native errors', () => {
    const inspect = vi.fn(() => ({
      ok: false,
      needsRebuild: false,
      failedModules: ['better-sqlite3'],
      message: 'permission denied',
    }))

    expect(() => ensureNativeRuntimeReady({ cwd: '/tmp/project', inspect, run: vi.fn() })).toThrow(
      'permission denied'
    )
  })

  it('surfaces a recovery error when rebuild does not fix the modules', () => {
    const inspect = vi
      .fn()
      .mockReturnValueOnce({
        ok: false,
        needsRebuild: true,
        failedModules: ['isolated-vm'],
        message: 'Native modules need rebuild for Node 24.14.1: isolated-vm',
      })
      .mockReturnValueOnce({
        ok: false,
        needsRebuild: true,
        failedModules: ['isolated-vm'],
        message: 'still broken',
      })

    expect(() => ensureNativeRuntimeReady({ cwd: '/tmp/project', inspect, run: vi.fn() })).toThrow('still broken')
  })
})
