import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runUiPostinstall, shouldInstallUiDependencies } from '../../scripts/postinstall-ui.mjs'

const tempDirs: string[] = []

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcpr-postinstall-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ui postinstall guard', () => {
  it('skips ui install when the ui manifest is absent', () => {
    const rootDir = makeTempRepo()
    const runNpm = vi.fn(() => 0)

    expect(shouldInstallUiDependencies(rootDir)).toBe(false)
    expect(runUiPostinstall(rootDir, runNpm)).toBe(0)
    expect(runNpm).not.toHaveBeenCalled()
  })

  it('runs ui install when the ui manifest is present', () => {
    const rootDir = makeTempRepo()
    mkdirSync(join(rootDir, 'ui'), { recursive: true })
    writeFileSync(join(rootDir, 'ui', 'package.json'), '{"name":"ui"}\n')
    const runNpm = vi.fn(() => 0)

    expect(shouldInstallUiDependencies(rootDir)).toBe(true)
    expect(runUiPostinstall(rootDir, runNpm)).toBe(0)
    expect(runNpm).toHaveBeenCalledWith(rootDir)
  })
})
