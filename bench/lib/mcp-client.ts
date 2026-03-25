export type JsonRpcResponse = {
  jsonrpc: string
  id: number | string | null
  result?: unknown
  error?: unknown
}

type InjectResponse = {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  json(): unknown
  body: string
}

type InjectFn = (input: {
  method: 'POST' | 'GET'
  url: string
  headers?: Record<string, string>
  payload?: unknown
}) => Promise<InjectResponse>

export class BenchmarkMcpClient {
  constructor(
    private readonly requestImpl: InjectFn,
    private readonly namespace: string,
    private readonly authHeader?: string,
  ) {}

  async initialize(
    mode: string = 'read',
    intent?: {
      intent?: string
      goal?: string
      query?: string
      taskContext?: string
    },
  ): Promise<{ sessionId: string }> {
    const response = await this.request({
      id: 1,
      method: 'initialize',
      params: {
        mode,
        ...(intent ?? {}),
      },
    })
    const sessionId = readHeader(response.headers, 'mcp-session-id')
    if (!sessionId) throw new Error('Missing Mcp-Session-Id header')
    return { sessionId }
  }

  async toolsList(sessionId: string): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>> {
    const response = await this.request({
      id: 2,
      method: 'tools/list',
      params: {},
    }, sessionId)
    const body = response.json() as JsonRpcResponse
    return ((body.result as { tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> })?.tools) ?? []
  }

  async callTool(sessionId: string, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const response = await this.request({
      id: 3,
      method: 'tools/call',
      params: { name, arguments: args },
    }, sessionId)
    const body = response.json() as JsonRpcResponse
    if (body.error) {
      throw new Error(JSON.stringify(body.error))
    }
    return body.result
  }

  async readSelectorTrace(sessionId: string): Promise<unknown> {
    const response = await this.requestImpl({
      method: 'GET',
      url: `/debug/selector/${sessionId}`,
    })
    if (response.statusCode < 200 || response.statusCode >= 300) return null
    return response.json()
  }

  private async request(body: Record<string, unknown>, sessionId?: string): Promise<InjectResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.authHeader) headers['Authorization'] = this.authHeader
    if (sessionId) headers['Mcp-Session-Id'] = sessionId

    const response = await this.requestImpl({
      method: 'POST',
      url: `/mcp/${this.namespace}`,
      headers,
      payload: {
        jsonrpc: '2.0',
        ...body,
      },
    })

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`MCP request failed with HTTP ${response.statusCode}: ${response.body}`)
    }
    return response
  }
}

function readHeader(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const direct = headers[name]
  if (typeof direct === 'string') return direct
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0]

  const normalizedKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
  if (!normalizedKey) return null
  const value = headers[normalizedKey]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return null
}
