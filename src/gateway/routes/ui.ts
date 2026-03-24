import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'

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

export async function uiRoutes(app: FastifyInstance): Promise<void> {
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
  })

  // Redirect bare /ui → /ui/
  app.get('/ui', (_req, reply) => reply.redirect('/ui/'))

  // Redirect root → /ui/
  app.get('/', (_req, reply) => reply.redirect('/ui/'))
}
