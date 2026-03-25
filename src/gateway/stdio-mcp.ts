import { createInterface } from 'node:readline'
import type { FastifyBaseLogger } from 'fastify'
import { ExecutionRouter } from '../router/router.js'
import type { DownstreamRegistry } from '../registry/registry.js'
import type { TriggerEngine } from '../trigger/index.js'
import type { IAuditLogger, IHealthMonitor, ISessionStore } from '../types/interfaces.js'
import type { RateLimiter } from '../resilience/rateLimiter.js'
import { GatewayError, GatewayErrorCode } from '../types/errors.js'
import { sanitizeError, isProductionMode } from '../utils/error-sanitize.js'
import { handleInitialize, handleToolsCall, handleToolsList } from './dispatch/index.js'
import {
  parseJsonRpcEnvelope,
  isNotificationMethod,
  isJsonRpcRequest,
  type JsonRpcEnvelope,
} from './jsonrpc.js'
import type { McpHandlerContext } from './mcp-handler-context.js'

export type RunStdioMcpOptions = {
  store: ISessionStore
  registry: DownstreamRegistry
  triggerEngine: TriggerEngine
  healthMonitor?: IHealthMonitor
  getRateLimiter?: () => RateLimiter | undefined
  getResponseTimeoutMs?: () => number | undefined
  auditLogger?: IAuditLogger
  namespace: string
  /** Synthetic Authorization header value (e.g. Bearer token); optional */
  authorization?: string
  logger?: FastifyBaseLogger
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
}

function writeLine(
  stream: NodeJS.WritableStream,
  payload: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const line = `${JSON.stringify(payload)}\n`
    stream.write(line, (err) => (err ? reject(err) : resolve()))
  })
}

function jsonRpcError(
  id: number | string | null | undefined,
  err: unknown,
): Record<string, unknown> {
  const sanitized = sanitizeError(err, isProductionMode())
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: -32000,
      message: sanitized.message,
      data: { error: sanitized.error, details: sanitized.details },
    },
  }
}

export async function runStdioMcp(options: RunStdioMcpOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const log = options.logger

  const router = new ExecutionRouter(
    options.registry,
    options.store,
    options.healthMonitor,
    options.getRateLimiter,
    options.getResponseTimeoutMs,
  )

  let boundSessionId: string | undefined
  let requestSeq = 0

  const rl = createInterface({ input: stdin, crlfDelay: Infinity })

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let parsedLine: unknown
    try {
      parsedLine = JSON.parse(trimmed) as unknown
    } catch (err) {
      await writeLine(stdout as NodeJS.WritableStream, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: err instanceof Error ? err.message : 'Parse error',
        },
      })
      continue
    }

    let envelope: JsonRpcEnvelope
    try {
      envelope = parseJsonRpcEnvelope(parsedLine)
    } catch (err) {
      const reqId =
        typeof parsedLine === 'object' &&
        parsedLine !== null &&
        'id' in parsedLine &&
        (typeof (parsedLine as { id: unknown }).id === 'number' ||
          typeof (parsedLine as { id: unknown }).id === 'string' ||
          (parsedLine as { id: unknown }).id === null)
          ? (parsedLine as { id: number | string | null }).id
          : undefined
      await writeLine(
        stdout as NodeJS.WritableStream,
        jsonRpcError(reqId, err instanceof GatewayError ? err : err),
      )
      continue
    }

    if (isNotificationMethod(envelope.method)) {
      continue
    }

    if (!isJsonRpcRequest(envelope)) {
      await writeLine(
        stdout as NodeJS.WritableStream,
        jsonRpcError(
          undefined,
          new GatewayError(GatewayErrorCode.INTERNAL_GATEWAY_ERROR, 'Invalid JSON-RPC body'),
        ),
      )
      continue
    }

    const body = envelope
    const requestId = `stdio-${++requestSeq}`

    const baseCtx = (sessionId?: string): McpHandlerContext => ({
      namespace: options.namespace,
      sessionId,
      authorization: options.authorization,
      requestId,
      log,
    })

    try {
      switch (body.method) {
        case 'initialize': {
          const { id, result } = await handleInitialize(
            baseCtx(),
            body,
            options.store,
            options.registry,
            options.auditLogger,
          )
          boundSessionId = id
          await writeLine(stdout as NodeJS.WritableStream, result as Record<string, unknown>)
          break
        }
        case 'tools/list': {
          if (!boundSessionId) {
            await writeLine(
              stdout as NodeJS.WritableStream,
              jsonRpcError(body.id, new GatewayError(GatewayErrorCode.SESSION_NOT_FOUND)),
            )
            break
          }
          const result = await handleToolsList(
            baseCtx(boundSessionId),
            body,
            options.store,
          )
          await writeLine(stdout as NodeJS.WritableStream, result as Record<string, unknown>)
          break
        }
        case 'tools/call': {
          if (!boundSessionId) {
            await writeLine(
              stdout as NodeJS.WritableStream,
              jsonRpcError(body.id, new GatewayError(GatewayErrorCode.SESSION_NOT_FOUND)),
            )
            break
          }
          const result = await handleToolsCall(
            baseCtx(boundSessionId),
            body,
            options.store,
            router,
            options.triggerEngine,
            options.auditLogger,
          )
          await writeLine(stdout as NodeJS.WritableStream, result as Record<string, unknown>)
          break
        }
        default:
          await writeLine(
            stdout as NodeJS.WritableStream,
            jsonRpcError(body.id, new GatewayError(GatewayErrorCode.UNSUPPORTED_OPERATION)),
          )
      }
    } catch (err) {
      await writeLine(stdout as NodeJS.WritableStream, jsonRpcError(body.id, err))
    }
  }
}
