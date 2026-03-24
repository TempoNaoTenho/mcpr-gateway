import { randomUUID } from 'node:crypto'

export interface FakeTool {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
}

export interface FakeMcpServerOptions {
  tools: FakeTool[]
  /** Artificial delay in ms before responding */
  delay?: number
  /** After this many requests, return HTTP 500 */
  failAfter?: number
}

export interface FakeMcpServer {
  url: string
  close: () => Promise<void>
}

type JsonRpcBody = Record<string, unknown>
type FakeFetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const MCP_SESSION_HEADER = 'Mcp-Session-Id'
const activeServers = new Map<string, FakeFetchHandler>()

let originalFetch: typeof globalThis.fetch | undefined

function installFetchShim(): void {
  if (originalFetch) return

  if (typeof globalThis.fetch !== 'function') {
    throw new Error('global fetch is not available in this test environment')
  }

  originalFetch = globalThis.fetch.bind(globalThis) as typeof globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const handler = activeServers.get(url)
    if (handler) {
      return handler(input, init)
    }

    if (!originalFetch) {
      throw new Error('fake MCP fetch shim is not installed')
    }

    return originalFetch(input, init)
  }) as typeof globalThis.fetch
}

function uninstallFetchShim(): void {
  if (!originalFetch || activeServers.size > 0) return
  globalThis.fetch = originalFetch
  originalFetch = undefined
}

function getHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  const overrideHeaders = new Headers(init?.headers)
  overrideHeaders.forEach((value, key) => headers.set(key, value))
  return headers
}

function readHeader(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  name: string,
): string | null {
  return getHeaders(input, init).get(name)
}

function bodyToString(body: RequestInit['body']): string {
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8')
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8')
  throw new Error('Unsupported request body type for fake MCP server')
}

function readBody(input: RequestInfo | URL, init?: RequestInit): JsonRpcBody {
  const rawBody =
    init?.body !== undefined
      ? bodyToString(init.body)
      : input instanceof Request
        ? ''
        : ''

  return JSON.parse(rawBody) as JsonRpcBody
}

function jsonResponse(
  status: number,
  body: unknown,
  sessionId?: string,
): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (sessionId) headers[MCP_SESSION_HEADER] = sessionId

  return new Response(JSON.stringify(body), { status, headers })
}

export async function createFakeMcpServer(options: FakeMcpServerOptions): Promise<FakeMcpServer> {
  const { tools, delay = 0, failAfter } = options
  let requestCount = 0
  const url = `http://fake-mcp.local/${randomUUID()}/mcp`
  const validSessionIds = new Set<string>()

  installFetchShim()
  activeServers.set(url, async (input: RequestInfo | URL, init?: RequestInit) => {
    requestCount++

    if (failAfter !== undefined && requestCount > failAfter) {
      return jsonResponse(500, { error: 'Forced failure' })
    }

    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }

    let body: JsonRpcBody
    try {
      body = readBody(input, init)
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON body' })
    }

    const method = body['method']
    const requestId = body['id']

    if (method === 'initialize') {
      const sessionId = `fake-session-${randomUUID()}`
      validSessionIds.add(sessionId)

      return jsonResponse(200, {
        jsonrpc: '2.0',
        id: requestId,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp-server', version: '1.0.0' },
        },
      }, sessionId)
    }

    const sessionId = readHeader(input, init, MCP_SESSION_HEADER)
    if (!sessionId || !validSessionIds.has(sessionId)) {
      return jsonResponse(400, {
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: 'Missing or invalid Mcp-Session-Id header' },
      })
    }

    if (method === 'notifications/initialized') {
      return new Response(null, {
        status: 202,
        headers: { [MCP_SESSION_HEADER]: sessionId },
      })
    }

    if (method === 'tools/list') {
      return jsonResponse(200, {
        jsonrpc: '2.0',
        id: requestId,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
          })),
        },
      }, sessionId)
    }

    if (method === 'tools/call') {
      const params = body['params'] as Record<string, unknown>
      const toolName = params?.['name'] as string

      return jsonResponse(200, {
        jsonrpc: '2.0',
        id: requestId,
        result: {
          content: [{ type: 'text', text: `Result of ${toolName}` }],
        },
      }, sessionId)
    }

    return jsonResponse(400, {
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32601, message: 'Method not found' },
    }, sessionId)
  })

  return {
    url,
    close: async () => {
      activeServers.delete(url)
      uninstallFetchShim()
    },
  }
}
