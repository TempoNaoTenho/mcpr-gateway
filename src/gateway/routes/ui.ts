import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import type { FastifyInstance } from 'fastify'

const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "media-src 'self'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "script-src-attr 'none'",
  'upgrade-insecure-requests',
].join(';')

function resolveCandidate(path: string): string {
  return path.startsWith('/') ? path : resolve(process.cwd(), path)
}

function resolveUiDir(): string | null {
  const candidates = [
    process.env['UI_STATIC_DIR'],
    join(process.cwd(), 'ui', 'dist'),
    join(process.cwd(), 'ui', 'build'),
  ].filter((value): value is string => Boolean(value))

  for (const path of candidates) {
    const candidate = resolveCandidate(path)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function isViteUiDevMode(): boolean {
  return process.env['GATEWAY_DEV_UI_MODE'] === 'vite'
}

export async function uiRoutes(app: FastifyInstance): Promise<void> {
  if (isViteUiDevMode()) {
    app.log.info(
      '[ui] Vite dev UI is active on the main dev port; static /ui serving is skipped in integrated dev.'
    )
    return
  }

  const uiDir = resolveUiDir()
  if (!uiDir) {
    app.log.warn('[ui] Built UI not found — skipping static file serving. Run `npm run build:ui` first.')
    return
  }

  app.log.info(`[ui] Serving static UI from ${uiDir}`)

  // Register @fastify/static — serves files from /ui/*
  // The plugin is registered dynamically to keep the top-level import optional.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fastifyStatic = (await import('@fastify/static')).default as any
  await app.register(fastifyStatic, {
    root: uiDir,
    prefix: '/ui/',
    // SPA fallback: unknown paths → index.html
    index: 'index.html',
    decorateReply: false,
    setHeaders: (res: ServerResponse) => {
      // SvelteKit static output uses an inline bootstrap script and wrapper style attribute.
      // Scope the relaxed CSP to UI documents instead of weakening the gateway-wide default.
      res.setHeader('Content-Security-Policy', UI_CONTENT_SECURITY_POLICY)
    },
  })

  // Redirect bare /ui → /ui/
  app.get('/ui', (_req, reply) => reply.redirect('/ui/'))

  // Redirect root → /ui/
  app.get('/', (_req, reply) => reply.redirect('/ui/'))
}
