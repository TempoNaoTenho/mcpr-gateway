import { randomUUID } from 'node:crypto'

export interface FixtureTool {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
}

export interface FixtureMcpServer {
  url: string
  close(): Promise<void>
}

type JsonRpcBody = Record<string, unknown>
type FakeFetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const MCP_SESSION_HEADER = 'Mcp-Session-Id'
const activeServers = new Map<string, FakeFetchHandler>()
let originalFetch: typeof globalThis.fetch | undefined
let shimInstallCount = 0

function installFetchShim(): void {
  shimInstallCount++
  if (shimInstallCount > 1) return
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('global fetch is not available in this environment')
  }

  originalFetch = globalThis.fetch.bind(globalThis) as typeof globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const handler = activeServers.get(url)
    if (handler) return handler(input, init)
    if (!originalFetch) throw new Error('fetch shim missing')
    return originalFetch(input, init)
  }) as typeof globalThis.fetch
}

function uninstallFetchShim(): void {
  shimInstallCount--
  if (shimInstallCount > 0) return
  if (!originalFetch) return
  globalThis.fetch = originalFetch
  originalFetch = undefined
}

function bodyToString(body: RequestInit['body']): string {
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8')
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8')
  throw new Error('Unsupported request body')
}

function readBody(init?: RequestInit): JsonRpcBody {
  const rawBody = init?.body !== undefined ? bodyToString(init.body) : ''
  return JSON.parse(rawBody) as JsonRpcBody
}

function jsonResponse(status: number, body: unknown, sessionId?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (sessionId) headers[MCP_SESSION_HEADER] = sessionId
  return new Response(JSON.stringify(body), { status, headers })
}

export async function createFixtureMcpServer(tools: FixtureTool[]): Promise<FixtureMcpServer> {
  const url = `http://fixture-mcp.local/${randomUUID()}/mcp`
  const validSessionIds = new Set<string>()
  installFetchShim()

  activeServers.set(url, async (_input: RequestInfo | URL, init?: RequestInit) => {
    let body: JsonRpcBody
    try {
      body = readBody(init)
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON body' })
    }

    const method = body['method']
    const requestId = body['id']
    if (method === 'initialize') {
      const sessionId = `fixture-session-${randomUUID()}`
      validSessionIds.add(sessionId)
      return jsonResponse(200, {
        jsonrpc: '2.0',
        id: requestId,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture-server', version: '1.0.0' },
        },
      }, sessionId)
    }

    const headers = new Headers(init?.headers)
    const sessionId = headers.get(MCP_SESSION_HEADER)
    if (!sessionId || !validSessionIds.has(sessionId)) {
      return jsonResponse(400, {
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: 'Missing or invalid Mcp-Session-Id header' },
      })
    }

    if (method === 'tools/list') {
      return jsonResponse(200, {
        jsonrpc: '2.0',
        id: requestId,
        result: {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
          })),
        },
      }, sessionId)
    }

    if (method === 'notifications/initialized') {
      return new Response(null, {
        status: 202,
        headers: { [MCP_SESSION_HEADER]: sessionId },
      })
    }

    if (method === 'tools/call') {
      const params = body['params'] as Record<string, unknown> | undefined
      const toolName = String(params?.['name'] ?? '')
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
    async close() {
      activeServers.delete(url)
      uninstallFetchShim()
    },
  }
}
