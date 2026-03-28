import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { uiRoutes } from '../../src/gateway/routes/ui.js'

const originalUiStaticDir = process.env['UI_STATIC_DIR']
const originalUiMode = process.env['GATEWAY_DEV_UI_MODE']
const originalCwd = process.cwd()

afterEach(() => {
  if (originalUiStaticDir === undefined) delete process.env['UI_STATIC_DIR']
  else process.env['UI_STATIC_DIR'] = originalUiStaticDir

  if (originalUiMode === undefined) delete process.env['GATEWAY_DEV_UI_MODE']
  else process.env['GATEWAY_DEV_UI_MODE'] = originalUiMode

  process.chdir(originalCwd)
})

describe('uiRoutes missing build handling', () => {
  it('logs info instead of a warning when Vite dev mode is active', async () => {
    process.env['UI_STATIC_DIR'] = '/tmp/mcpr-missing-ui-build'
    process.env['GATEWAY_DEV_UI_MODE'] = 'vite'

    const app = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    }

    await uiRoutes(app as never)

    expect(app.log.info).toHaveBeenCalledWith(
      '[ui] Vite dev UI is active on the main dev port; static /ui serving is skipped in integrated dev.'
    )
    expect(app.log.warn).not.toHaveBeenCalled()
  })

  it('warns when static UI is missing outside integrated dev mode', async () => {
    process.env['UI_STATIC_DIR'] = '/tmp/mcpr-missing-ui-build'
    delete process.env['GATEWAY_DEV_UI_MODE']
    const isolatedCwd = mkdtempSync(join(tmpdir(), 'mcpr-ui-routes-'))
    process.chdir(isolatedCwd)

    const app = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    }

    await uiRoutes(app as never)

    expect(app.log.warn).toHaveBeenCalledWith(
      '[ui] Built UI not found — skipping static file serving. Run `npm run build:ui` first.'
    )

    rmSync(isolatedCwd, { recursive: true, force: true })
  })
})
