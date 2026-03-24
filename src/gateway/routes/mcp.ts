import { z } from 'zod'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { NamespaceSchema } from '../../types/identity.js'
import { GatewayError, GatewayErrorCode } from '../../types/errors.js'
import { handleInitialize, handleToolsList, handleToolsCall } from '../dispatch/index.js'
import type { ISessionStore, IHealthMonitor, IAuditLogger } from '../../types/interfaces.js'
import type { DownstreamRegistry } from '../../registry/registry.js'
import { ExecutionRouter } from '../../router/router.js'
import type { TriggerEngine } from '../../trigger/index.js'
import type { RateLimiter } from '../../resilience/rateLimiter.js'

const JsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.string(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
})

const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i
const MCP_ALLOWED_HEADERS = 'Authorization, Content-Type, Mcp-Session-Id'
const MCP_EXPOSED_HEADERS = 'Mcp-Session-Id, Mcp-Tools-Changed'
const SSE_PING_INTERVAL_MS = 15_000

type JsonRpcBody = {
  jsonrpc: string
  id: number | string | null
  method: string
  params?: Record<string, unknown>
}

type JsonRpcEnvelope =
  | JsonRpcBody
  | {
      jsonrpc: string
      method: string
      params?: Record<string, unknown>
    }

interface McpRouteOptions {
  store: ISessionStore
  registry: DownstreamRegistry
  triggerEngine: TriggerEngine
  healthMonitor?: IHealthMonitor
  getRateLimiter?: () => RateLimiter | undefined
  getResponseTimeoutMs?: () => number | undefined
  auditLogger?: IAuditLogger
}

function setMcpCorsHeaders(reply: FastifyReply, origin: string | undefined): void {
  if (!origin || !LOOPBACK_ORIGIN.test(origin)) return

  reply.header('Access-Control-Allow-Origin', origin)
  reply.header('Vary', 'Origin')
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  reply.header('Access-Control-Allow-Headers', MCP_ALLOWED_HEADERS)
  reply.header('Access-Control-Expose-Headers', MCP_EXPOSED_HEADERS)
}

function isNotificationMethod(method: string): boolean {
  return method.startsWith('notifications/')
}

function isJsonRpcRequest(body: JsonRpcEnvelope): body is JsonRpcBody {
  return 'id' in body
}

function parseJsonRpcEnvelope(body: unknown): JsonRpcEnvelope {
  const bodyResult = JsonRpcEnvelopeSchema.safeParse(body)
  if (!bodyResult.success) {
    throw new GatewayError(
      GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
      'Invalid JSON-RPC body',
      bodyResult.error.issues
    )
  }

  const envelope = bodyResult.data
  if (!isNotificationMethod(envelope.method) && envelope.id === undefined) {
    throw new GatewayError(GatewayErrorCode.INTERNAL_GATEWAY_ERROR, 'Invalid JSON-RPC body', [
      {
        code: 'invalid_type',
        expected: 'number | string | null',
        received: 'undefined',
        path: ['id'],
        message: 'Required',
      },
    ])
  }

  return envelope as JsonRpcEnvelope
}

function openSseStream(reply: FastifyReply, origin: string | undefined): void {
  reply.hijack()
  reply.raw.statusCode = 200
  if (origin && LOOPBACK_ORIGIN.test(origin)) {
    reply.raw.setHeader('Access-Control-Allow-Origin', origin)
    reply.raw.setHeader('Vary', 'Origin')
    reply.raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    reply.raw.setHeader('Access-Control-Allow-Headers', MCP_ALLOWED_HEADERS)
    reply.raw.setHeader('Access-Control-Expose-Headers', MCP_EXPOSED_HEADERS)
  }
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
    opts.getResponseTimeoutMs
  )

  app.options<{ Params: { namespace: string } }>('/mcp/:namespace', async (request, reply) => {
    const namespaceResult = NamespaceSchema.safeParse(request.params.namespace)
    if (!namespaceResult.success) {
      return reply.status(400).send({
        error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
        message: 'Invalid namespace',
        details: namespaceResult.error.issues,
      })
    }

    setMcpCorsHeaders(reply, request.headers.origin)
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

    openSseStream(reply, request.headers.origin)
  })

  app.post<{ Params: { namespace: string } }>('/mcp/:namespace', async (request, reply) => {
    setMcpCorsHeaders(reply, request.headers.origin)

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
        const { id, result } = await handleInitialize(request, body, store, registry, auditLogger)
        reply.header('Mcp-Session-Id', id)
        return reply.send(result)
      }

      case 'tools/list': {
        const result = await handleToolsList(request, body, store, reply)
        return reply.send(result)
      }

      case 'tools/call': {
        const result = await handleToolsCall(
          request,
          body,
          store,
          router,
          triggerEngine,
          auditLogger
        )
        return reply.send(result)
      }

      default:
        throw new GatewayError(GatewayErrorCode.UNSUPPORTED_OPERATION)
    }
  })
}
