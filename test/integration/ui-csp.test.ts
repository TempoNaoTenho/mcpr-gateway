import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../src/gateway/server.js'
import { uiRoutes } from '../../src/gateway/routes/ui.js'
import { healthRoutes } from '../../src/gateway/routes/health.js'

const originalUiStaticDir = process.env['UI_STATIC_DIR']

afterEach(() => {
  if (originalUiStaticDir === undefined) delete process.env['UI_STATIC_DIR']
  else process.env['UI_STATIC_DIR'] = originalUiStaticDir
})

describe('UI CSP', () => {
  it('allows SvelteKit inline bootstrap only on /ui assets', async () => {
    const uiDir = mkdtempSync(join(tmpdir(), 'mcpr-ui-csp-'))
    writeFileSync(
      join(uiDir, 'index.html'),
      '<!doctype html><html><body><div style="display: contents"><script>window.__ui = true</script></div></body></html>'
    )

    process.env['UI_STATIC_DIR'] = uiDir

    const app = buildServer({ logLevel: 'silent' })
    await app.register(uiRoutes)
    await app.register(healthRoutes)
    await app.ready()

    try {
      const uiResponse = await app.inject({ method: 'GET', url: '/ui/' })
      const healthResponse = await app.inject({ method: 'GET', url: '/health' })

      expect(uiResponse.statusCode).toBe(200)
      expect(String(uiResponse.headers['content-security-policy'])).toContain(
        "script-src 'self' 'unsafe-inline'"
      )
      expect(String(uiResponse.headers['content-security-policy'])).toContain(
        "style-src 'self' 'unsafe-inline'"
      )

      expect(healthResponse.statusCode).toBe(200)
      expect(String(healthResponse.headers['content-security-policy'])).not.toContain(
        "'unsafe-inline'"
      )
    } finally {
      await app.close()
      rmSync(uiDir, { recursive: true, force: true })
    }
  })
})
