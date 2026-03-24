import { describe, expect, it } from 'vitest'
import * as path from 'path'

/**
 * Stability Error Handler Tests
 *
 * RED phase of TDD: Tests that expect correct behavior but currently fail.
 *
 * These tests verify that:
 * - AC4: uncaughtException handler prevents crashes and exits gracefully
 * - AC5: unhandledRejection handler prevents crashes and exits gracefully
 * - AC6: isolate.dispose() is called on all error paths in sandbox execution
 * - AC7: process.kill() includes proper cleanup (clear timeout)
 * - AC8: SSE keepalive intervals are cleared on disconnect
 */

function readSourceFile(relativePath: string): string {
  const fs = require('fs')
  const absolutePath = path.resolve(__dirname, '..', '..', '..', relativePath)
  return fs.readFileSync(absolutePath, 'utf-8')
}

describe('Stability Error Handlers', () => {
  describe('AC4: uncaughtException handler', () => {
    it('should have uncaughtException handler registered in index.ts', () => {
      const indexSource = readSourceFile('src/index.ts')

      // Should register uncaughtException handler
      const hasUncaughtExceptionHandler = indexSource.includes("process.on('uncaughtException'")
      expect(hasUncaughtExceptionHandler).toBe(true)
    })

    it('should log error and call process.exit in uncaughtException handler', () => {
      const indexSource = readSourceFile('src/index.ts')

      // Handler should log error and call process.exit
      const hasErrorLogging =
        /uncaughtException[\s\S]*?console\.error/.test(indexSource) ||
        indexSource.includes('process.emitWarning')
      const hasExitCall =
        /uncaughtException[\s\S]*?process\.exit/.test(indexSource) ||
        indexSource.includes('process.exit(1)')
      expect(hasErrorLogging).toBe(true)
      expect(hasExitCall).toBe(true)
    })
  })

  describe('AC5: unhandledRejection handler', () => {
    it('should have unhandledRejection handler registered in index.ts', () => {
      const indexSource = readSourceFile('src/index.ts')

      // Should register unhandledRejection handler
      const hasHandler = indexSource.includes("process.on('unhandledRejection'")
      expect(hasHandler).toBe(true)
    })

    it('should log error and call process.exit in unhandledRejection handler', () => {
      const indexSource = readSourceFile('src/index.ts')

      // Handler should log error and call process.exit
      const hasErrorLogging =
        /unhandledRejection[\s\S]*?console\.error/.test(indexSource) ||
        indexSource.includes('process.emitWarning')
      const hasExitCall =
        /unhandledRejection[\s\S]*?process\.exit/.test(indexSource) ||
        indexSource.includes('process.exit(1)')
      expect(hasErrorLogging).toBe(true)
      expect(hasExitCall).toBe(true)
    })
  })

  describe('AC6: isolate.dispose() cleanup on error paths', () => {
    it('should call isolate.dispose() in finally block of executeWithIsolatedVm', () => {
      const sandboxSource = readSourceFile('src/runtime/sandbox.ts')

      // The dispose should be in a finally block to ensure cleanup
      // Looking for: try { ... } finally { isolate.dispose() }
      const hasFinallyDispose = /finally\s*\{[\s\S]*?isolate\.dispose\(\)/.test(sandboxSource)
      expect(hasFinallyDispose).toBe(true)
    })

    it('should dispose isolate even when context.eval throws', () => {
      // This verifies the try/finally pattern exists
      const sandboxSource = readSourceFile('src/runtime/sandbox.ts')

      // Should have try block around context.eval
      const hasTryAroundEval = /try\s*\{[\s\S]*?context\.eval/.test(sandboxSource)
      expect(hasTryAroundEval).toBe(true)
    })

    it('should dispose isolate even when Isolate constructor throws', () => {
      const sandboxSource = readSourceFile('src/runtime/sandbox.ts')

      // Isolate creation should be inside try block
      // This ensures dispose() in finally is called even if new Isolate() fails
      const hasTryAroundIsolate = /try\s*\{[\s\S]*?new\s+\w*\.?Isolate/.test(sandboxSource)
      expect(hasTryAroundIsolate).toBe(true)
    })
  })

  describe('AC7: process.kill() cleanup', () => {
    it('should clear timer before process.kill() in stdio transport', () => {
      const stdioSource = readSourceFile('src/registry/transport/stdio.ts')

      // Find the processChild.kill() call and check if clearTimeout comes before it
      const lines = stdioSource.split('\n')
      const killLineIndex = lines.findIndex((l) => l.includes('processChild.kill()'))

      expect(killLineIndex).toBeGreaterThan(0)

      // Look backwards from kill to find clearTimeout
      let hasPreKillClear = false
      for (let i = Math.max(0, killLineIndex - 5); i < killLineIndex; i++) {
        if (lines[i].includes('clearTimeout')) {
          hasPreKillClear = true
          break
        }
      }

      expect(hasPreKillClear).toBe(true)
    })

    it('should not leave dangling timers after process termination', () => {
      const stdioSource = readSourceFile('src/registry/transport/stdio.ts')

      // Verify both timer creation and clear exist
      const hasTimer = stdioSource.includes('setTimeout(')
      const hasKill = stdioSource.includes('processChild.kill()')

      expect(hasTimer).toBe(true)
      expect(hasKill).toBe(true)

      // Check clearTimeout is near kill
      const killIndex = stdioSource.indexOf('processChild.kill()')
      const clearIndex = stdioSource.indexOf('clearTimeout', killIndex - 200)

      expect(clearIndex).toBeGreaterThan(killIndex - 200)
    })
  })

  describe('AC8: SSE keepalive interval cleanup', () => {
    it('should clear SSE keepalive interval on connection close', () => {
      const mcpSource = readSourceFile('src/gateway/routes/mcp.ts')

      // Check that clearInterval is called on 'close' event
      const hasCloseListener = mcpSource.includes("reply.raw.on('close'")
      const hasClearInterval = mcpSource.includes('clearInterval(keepAlive)')

      expect(hasCloseListener).toBe(true)
      expect(hasClearInterval).toBe(true)
    })

    it('should prevent SSE keepalive interval memory leaks', () => {
      const mcpSource = readSourceFile('src/gateway/routes/mcp.ts')

      // The interval should be defined with setInterval
      const hasSetInterval = mcpSource.includes('setInterval')

      // And there should be a corresponding clearInterval on close
      const hasCloseWithClearInterval = /reply\.raw\.on\('close'[\s\S]*?keepAlive/.test(mcpSource)

      expect(hasSetInterval).toBe(true)
      expect(hasCloseWithClearInterval).toBe(true)
    })
  })
})
