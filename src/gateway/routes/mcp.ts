import type { FastifyInstance, FastifyReply } from 'fastify'
import { NamespaceSchema } from '../../types/identity.js'
import { GatewayError, GatewayErrorCode } from '../../types/errors.js'
import { handleInitialize, handleToolsList, handleToolsCall } from '../dispatch/index.js'
import type { ISessionStore, IHealthMonitor, IAuditLogger } from '../../types/interfaces.js'
import type { DownstreamRegistry } from '../../registry/registry.js'
import { ExecutionRouter } from '../../router/router.js'
import type { TriggerEngine } from '../../trigger/index.js'
import type { RateLimiter } from '../../resilience/rateLimiter.js'
import {
  parseJsonRpcEnvelope,
  isNotificationMethod,
  isJsonRpcRequest,
  type JsonRpcEnvelope,
} from '../jsonrpc.js'
import { mcpContextFromFastifyRequest } from '../mcp-handler-context.js'
import { getConfig } from '../../config/index.js'
import { getInboundOAuth } from '../../auth/oauth-config.js'
import {
  isBrowserOriginAllowed,
  setMcpCorsHeaders,
  MCP_ALLOWED_HEADERS,
  MCP_EXPOSED_HEADERS,
} from '../cors.js'

const SSE_PING_INTERVAL_MS = 15_000

interface McpRouteOptions {
  store: ISessionStore
  registry: DownstreamRegistry
  triggerEngine: TriggerEngine
  healthMonitor?: IHealthMonitor
  getRateLimiter?: () => RateLimiter | undefined
  getResponseTimeoutMs?: () => number | undefined
  auditLogger?: IAuditLogger
}

function allowedBrowserOrigins(): string[] | undefined {
  return getInboundOAuth(getConfig().auth)?.allowedBrowserOrigins
}

function assertMcpOrigin(origin: string | undefined): void {
  const oauth = getInboundOAuth(getConfig().auth)
  const allowed = oauth?.allowedBrowserOrigins
  if (origin && !isBrowserOriginAllowed(origin, allowed)) {
    throw new GatewayError(GatewayErrorCode.MCP_INVALID_ORIGIN)
  }
}

function setSseCorsHeadersRaw(reply: FastifyReply, origin: string | undefined): void {
  if (!origin || !isBrowserOriginAllowed(origin, allowedBrowserOrigins())) {
    return
  }
  reply.raw.setHeader('Access-Control-Allow-Origin', origin)
  reply.raw.setHeader('Vary', 'Origin')
  reply.raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE')
  reply.raw.setHeader('Access-Control-Allow-Headers', MCP_ALLOWED_HEADERS)
  reply.raw.setHeader('Access-Control-Expose-Headers', MCP_EXPOSED_HEADERS)
}

function openSseStream(reply: FastifyReply, origin: string | undefined): void {
  reply.hijack()
  reply.raw.statusCode = 200
  setSseCorsHeadersRaw(reply, origin)
  reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.setHeader('X-Accel-Buffering', 'no')
  reply.raw.flushHeaders?.()
  reply.raw.write(': connected\n\n')

  if (process.env['VITEST']) {
    reply.raw.end()
    return
  }

  const keepAlive = setInterval(() => {
    if (!reply.raw.writableEnded && !reply.raw.destroyed) {
      reply.raw.write(': keepalive\n\n')
    }
  }, SSE_PING_INTERVAL_MS)

  reply.raw.on('close', () => {
    try {
      clearInterval(keepAlive)
    } catch {
      // ignore cleanup errors
    }
  })
}

export async function mcpRoutes(app: FastifyInstance, opts: McpRouteOptions): Promise<void> {
  const { store, registry, triggerEngine, healthMonitor, auditLogger } = opts
  const router = new ExecutionRouter(
    registry,
    store,
    healthMonitor,
    opts.getRateLimiter,
    opts.getResponseTimeoutMs,
    app.log,
  )

  const jsonParser = (
    _req: unknown,
    body: string,
    done: (err: Error | null, body?: unknown) => void,
  ) => {
    try {
      done(null, JSON.parse(body))
    } catch {
      done(new Error('invalid_json'))
    }
  }

  app.addContentTypeParser(
    /^application\/([\w!#$&^*.+-]|\.)*\+?json\s*(;.*)?$/i,
    { parseAs: 'string' },
    jsonParser,
  )
  app.addContentTypeParser(/^text\/plain\s*(;.*)?$/i, { parseAs: 'string' }, jsonParser)

  app.options<{ Params: { namespace: string } }>('/mcp/:namespace', async (request, reply) => {
    const namespaceResult = NamespaceSchema.safeParse(request.params.namespace)
    if (!namespaceResult.success) {
      return reply.status(400).send({
        error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
        message: 'Invalid namespace',
        details: namespaceResult.error.issues,
      })
    }

    assertMcpOrigin(typeof request.headers.origin === 'string' ? request.headers.origin : undefined)
    setMcpCorsHeaders(reply, request.headers.origin, allowedBrowserOrigins())
    return reply.status(204).send()
  })

  app.get<{ Params: { namespace: string } }>('/mcp/:namespace', async (request, reply) => {
    const namespaceResult = NamespaceSchema.safeParse(request.params.namespace)
    if (!namespaceResult.success) {
      return reply.status(400).send({
        error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
        message: 'Invalid namespace',
        details: namespaceResult.error.issues,
      })
    }

    assertMcpOrigin(typeof request.headers.origin === 'string' ? request.headers.origin : undefined)
    openSseStream(reply, typeof request.headers.origin === 'string' ? request.headers.origin : undefined)
  })

  app.post<{ Params: { namespace: string } }>('/mcp/:namespace', async (request, reply) => {
    assertMcpOrigin(typeof request.headers.origin === 'string' ? request.headers.origin : undefined)
    setMcpCorsHeaders(reply, request.headers.origin, allowedBrowserOrigins())

    const namespaceResult = NamespaceSchema.safeParse(request.params.namespace)
    if (!namespaceResult.success) {
      return reply.status(400).send({
        error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
        message: 'Invalid namespace',
        details: namespaceResult.error.issues,
      })
    }

    let body: JsonRpcEnvelope
    try {
      body = parseJsonRpcEnvelope(request.body)
    } catch (err) {
      if (err instanceof GatewayError) {
        return reply.status(400).send({
          error: err.code,
          message: err.message,
          details: err.details,
        })
      }

      return reply.status(400).send({
        error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
        message: 'Invalid JSON-RPC body',
      })
    }

    if (isNotificationMethod(body.method)) {
      return reply.status(202).send()
    }

    if (!isJsonRpcRequest(body)) {
      return reply.status(400).send({
        error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
        message: 'Invalid JSON-RPC body',
        details: [
          {
            code: 'invalid_type',
            expected: 'number | string | null',
            received: 'undefined',
            path: ['id'],
            message: 'Required',
          },
        ],
      })
    }

    switch (body.method) {
      case 'initialize': {
        const ctx = mcpContextFromFastifyRequest(request)
        const { id, negotiatedProtocolVersion, result } = await handleInitialize(
          ctx,
          body,
          store,
          registry,
          auditLogger,
        )
        reply.header('Mcp-Session-Id', id)
        reply.header('MCP-Protocol-Version', negotiatedProtocolVersion)
        return reply.send(result)
      }

      case 'tools/list': {
        const ctx = mcpContextFromFastifyRequest(request, { reply })
        const result = await handleToolsList(ctx, body, store)
        return reply.send(result)
      }

      case 'tools/call': {
        const ctx = mcpContextFromFastifyRequest(request)
        const result = await handleToolsCall(
          ctx,
          body,
          store,
          router,
          triggerEngine,
          auditLogger,
        )
        return reply.send(result)
      }

      default:
        throw new GatewayError(GatewayErrorCode.UNSUPPORTED_OPERATION)
    }
  })
}
