import type { DownstreamServer } from '../../types/server.js'
import type { ToolSchema } from '../../types/tools.js'
import { downstreamAuthManager, isDownstreamAuthError } from '../auth/index.js'

const DEFAULT_TIMEOUT_MS = 10_000
const MCP_SESSION_HEADER = 'Mcp-Session-Id'
const STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'
const JSON_CONTENT_TYPE = 'application/json'
const SSE_CONTENT_TYPE = 'text/event-stream'

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: number
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = {
  result?: Record<string, unknown>
  error?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.includes('aborted'))
  )
}

function getResponseContentType(response: Response): string {
  return response.headers.get('Content-Type')?.toLowerCase() ?? ''
}

function validateJsonRpcBody(server: DownstreamServer, body: unknown): JsonRpcResponse {
  if (!isRecord(body)) {
    throw new Error(`[registry/http] Server ${server.id} returned invalid JSON-RPC payload`)
  }

  const result = body['result']
  const error = body['error']
  if (result !== undefined && !isRecord(result)) {
    throw new Error(`[registry/http] Server ${server.id} returned non-object JSON-RPC result`)
  }

  return { result, error }
}

async function readJsonBody(server: DownstreamServer, response: Response): Promise<JsonRpcResponse> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`[registry/http] Server ${server.id} returned non-JSON response from ${server.url}`)
  }

  return validateJsonRpcBody(server, body)
}

type SseEvent = {
  event?: string
  data: string
}

function parseSseEvent(block: string): SseEvent | undefined {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith(':'))

  if (lines.length === 0) return undefined

  let event: string | undefined
  const dataLines: string[] = []
  for (const line of lines) {
    const separatorIndex = line.indexOf(':')
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex)
    const rawValue = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue

    if (field === 'event') {
      event = value
      continue
    }

    if (field === 'data') {
      dataLines.push(value)
    }
  }

  if (dataLines.length === 0) return undefined
  return { event, data: dataLines.join('\n') }
}

async function readSseJsonRpcBody(
  server: DownstreamServer,
  response: Response,
  request: JsonRpcRequest,
  timeoutMs: number,
): Promise<JsonRpcResponse> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error(`[registry/http] Server ${server.id} returned an empty SSE stream from ${server.url}`)
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void reader
      .cancel(`[registry/http] Timed out waiting for SSE response from ${server.url}`)
      .catch(() => {
        /* ignore: avoid unhandledRejection if cancel fails */
      })
  }, timeoutMs)

  const requestId = request.id

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''

      for (const block of blocks) {
        const event = parseSseEvent(block)
        if (!event || event.data.length === 0) continue

        let parsed: unknown
        try {
          parsed = JSON.parse(event.data)
        } catch {
          throw new Error(`[registry/http] Server ${server.id} returned invalid JSON in SSE event from ${server.url}`)
        }

        if (!isRecord(parsed)) continue
        if (requestId !== undefined && parsed['id'] !== requestId) continue
        return validateJsonRpcBody(server, parsed)
      }
    }

    const tailEvent = parseSseEvent(buffer)
    if (tailEvent && tailEvent.data.length > 0) {
      let parsed: unknown
      try {
        parsed = JSON.parse(tailEvent.data)
      } catch {
        throw new Error(`[registry/http] Server ${server.id} returned invalid JSON in SSE event from ${server.url}`)
      }

      if (isRecord(parsed) && (requestId === undefined || parsed['id'] === requestId)) {
        return validateJsonRpcBody(server, parsed)
      }
    }

    if (timedOut) {
      throw new Error(`[registry/http] Timed out waiting for SSE response from ${server.url}`)
    }

    throw new Error(
      `[registry/http] Server ${server.id} SSE stream ended without a matching JSON-RPC response for ${request.method}`,
    )
  } catch (err) {
    if (timedOut || isAbortError(err)) {
      throw new Error(`[registry/http] Timed out waiting for SSE response from ${server.url}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    try {
      await reader.cancel()
    } catch {
      // ignore cancellation errors once a matching event has been read
    }
  }
}

async function buildRequestHeaders(server: DownstreamServer, sessionId?: string): Promise<Record<string, string>> {
  const authHeaders = await downstreamAuthManager.resolveAuthHeaders(server)
  const headers: Record<string, string> = {
    ...(server.headers ?? {}),
    ...authHeaders,
    'Content-Type': 'application/json',
  }
  if (!headers['Accept']) {
    headers['Accept'] = server.transport === 'streamable-http'
      ? STREAMABLE_HTTP_ACCEPT
      : 'application/json'
  }
  if (sessionId) headers[MCP_SESSION_HEADER] = sessionId
  return headers
}

export async function postJsonRpc(
  server: DownstreamServer,
  request: JsonRpcRequest,
  sessionId?: string,
  timeoutMs?: number,
): Promise<{ body: JsonRpcResponse; sessionId?: string }> {
  const url = server.url!
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: await buildRequestHeaders(server, sessionId),
      body: JSON.stringify(request),
      signal: controller.signal,
    })
  } catch (err) {
    if (isDownstreamAuthError(err)) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`[registry/http] Request to ${url} failed: ${msg}`)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    if (response.status === 401) {
      await downstreamAuthManager.handleUnauthorized(
        server.id,
        response.headers.get('WWW-Authenticate') ?? undefined,
      )
    }
    throw new Error(
      `[registry/http] Server ${server.id} returned HTTP ${response.status} from ${url}`,
    )
  }

  const contentType = getResponseContentType(response)
  let body: JsonRpcResponse
  if (contentType.includes(JSON_CONTENT_TYPE)) {
    body = await readJsonBody(server, response)
  } else if (contentType.includes(SSE_CONTENT_TYPE)) {
    body = await readSseJsonRpcBody(server, response, request, effectiveTimeoutMs)
  } else {
    throw new Error(
      `[registry/http] Server ${server.id} returned unsupported content-type ${contentType || '<missing>'} from ${url}`,
    )
  }

  return {
    body,
    sessionId: response.headers.get(MCP_SESSION_HEADER) ?? sessionId,
  }
}

async function postJsonRpcNotification(
  server: DownstreamServer,
  request: Omit<JsonRpcRequest, 'id'>,
  sessionId?: string,
): Promise<{ sessionId?: string }> {
  const url = server.url!
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: await buildRequestHeaders(server, sessionId),
      body: JSON.stringify(request),
      signal: controller.signal,
    })

    if (!response.ok) {
      if (response.status === 401) {
        await downstreamAuthManager.handleUnauthorized(
          server.id,
          response.headers.get('WWW-Authenticate') ?? undefined,
        )
      }
      throw new Error(
        `[registry/http] Server ${server.id} returned HTTP ${response.status} from ${url}`,
      )
    }

    return {
      sessionId: response.headers.get(MCP_SESSION_HEADER) ?? sessionId,
    }
  } catch (err) {
    if (isDownstreamAuthError(err)) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`[registry/http] Request to ${url} failed: ${msg}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchToolsHttp(server: DownstreamServer, timeoutMs?: number): Promise<ToolSchema[]> {
  const initResponse = await postJsonRpc(server, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcpr-gateway', version: '1.0.0' },
    },
  }, undefined, timeoutMs)

  if (initResponse.body.error) {
    throw new Error(
      `[registry/http] initialize failed for ${server.id}: ${JSON.stringify(initResponse.body.error)}`,
    )
  }

  const initializedResponse = await postJsonRpcNotification(
    server,
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    initResponse.sessionId,
  )

  const toolsResponse = await postJsonRpc(
    server,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    initializedResponse.sessionId,
    timeoutMs,
  )

  if (toolsResponse.body.error) {
    throw new Error(
      `[registry/http] tools/list failed for ${server.id}: ${JSON.stringify(toolsResponse.body.error)}`,
    )
  }

  const tools = toolsResponse.body.result?.['tools']
  if (!Array.isArray(tools)) {
    throw new Error(
      `[registry/http] Server ${server.id} response missing result.tools (got: ${JSON.stringify(toolsResponse.body)})`,
    )
  }

  downstreamAuthManager.markAuthorized(server.id)
  return tools as ToolSchema[]
}

export async function callToolHttp(
  server: DownstreamServer,
  toolName: string,
  args: unknown,
  timeoutMs?: number,
): Promise<{ result?: unknown; error?: unknown }> {
  const initResponse = await postJsonRpc(server, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcpr-gateway', version: '1.0.0' },
    },
  }, undefined, timeoutMs)

  if (initResponse.body.error) {
    throw new Error(
      `[registry/http] initialize failed for ${server.id}: ${JSON.stringify(initResponse.body.error)}`,
    )
  }

  const initializedResponse = await postJsonRpcNotification(
    server,
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    initResponse.sessionId,
  )

  const callResponse = await postJsonRpc(
    server,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: args as Record<string, unknown> },
    },
    initializedResponse.sessionId,
    timeoutMs,
  )

  downstreamAuthManager.markAuthorized(server.id)
  return { result: callResponse.body.result, error: callResponse.body.error }
}
