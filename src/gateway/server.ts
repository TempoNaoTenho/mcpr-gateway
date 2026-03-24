import Fastify, { type FastifyInstance } from 'fastify'
import sensible from '@fastify/sensible'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import { nanoid } from 'nanoid'
import { ZodError } from 'zod'
import { GatewayError } from '../types/errors.js'
import { sanitizeError, logErrorInternal, isProductionMode } from '../utils/error-sanitize.js'

export function buildServer(opts?: { logLevel?: string }): FastifyInstance {
  const app = Fastify({
    logger: { level: opts?.logLevel ?? 'info' },
    genReqId: () => nanoid(8),
  })

  app.register(sensible)
  app.register(cookie)
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    frameguard: {
      action: 'deny',
    },
    noSniff: true,
    xssFilter: true,
  })

  const production = isProductionMode()

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof GatewayError) {
      return reply.status(err.statusCode).send(sanitizeError(err, production))
    }

    if (err instanceof ZodError) {
      logErrorInternal(err, (e) => app.log.error(e))
      return reply.status(400).send(sanitizeError(err, production))
    }

    if (err instanceof Error) {
      const sc = (err as Error & { statusCode?: number }).statusCode
      if (
        typeof sc === 'number' &&
        sc === 429 &&
        err.message === 'RATE_LIMIT_EXCEEDED'
      ) {
        logErrorInternal(err, (e) => app.log.error(e))
        const after = (err as { rateLimitRetryAfter?: string }).rateLimitRetryAfter
        return reply.status(429).send({
          error: 'RATE_LIMIT_EXCEEDED',
          ...(after ? { retryAfter: after } : {}),
        })
      }

      logErrorInternal(err, (e) => app.log.error(e))
      return reply.status(500).send(sanitizeError(err, production))
    }

    logErrorInternal(err, (e) => app.log.error(e))
    return reply.status(500).send(sanitizeError(err, production))
  })

  return app
}
