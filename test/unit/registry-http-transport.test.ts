import { afterEach, describe, expect, it, vi } from 'vitest'
import { callToolHttp, fetchToolsHttp } from '../../src/registry/transport/http.js'
import type { DownstreamServer } from '../../src/types/server.js'
import { DownstreamAuthStatus, SourceTrustLevel } from '../../src/types/enums.js'
import { downstreamAuthManager } from '../../src/registry/auth/index.js'

const makeServer = (overrides: Partial<DownstreamServer> = {}): DownstreamServer => ({
  id: 'http-server',
  namespaces: ['gmail'],
  transport: 'http',
  url: 'http://localhost:9999/mcp',
  enabled: true,
  trustLevel: SourceTrustLevel.Verified,
  ...overrides,
})

const sseResponse = (body: unknown, headers?: Record<string, string>): Response =>
  new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', ...(headers ?? {}) },
  })

describe('fetchToolsHttp()', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    downstreamAuthManager.syncServers([])
    delete process.env['TEST_MCP_BEARER_TOKEN']
  })

  it('initializes the downstream session before requesting tools/list', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-123' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 202,
        headers: { 'Mcp-Session-Id': 'session-123' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'list_messages', inputSchema: { type: 'object' } }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const tools = await fetchToolsHttp(makeServer())

    expect(tools).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const initRequest = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(initRequest.body).toContain('"method":"initialize"')
    expect((initRequest.headers as Record<string, string>)['Authorization']).toBeUndefined()

    const initializedRequest = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(initializedRequest.body).toContain('"method":"notifications/initialized"')
    expect((initializedRequest.headers as Record<string, string>)['Mcp-Session-Id']).toBe(
      'session-123',
    )

    const toolsRequest = fetchMock.mock.calls[2]?.[1] as RequestInit
    expect(toolsRequest.body).toContain('"method":"tools/list"')
    expect((toolsRequest.headers as Record<string, string>)['Mcp-Session-Id']).toBe('session-123')
  })

  it('merges configured server headers into every HTTP request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-123' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 202,
        headers: { 'Mcp-Session-Id': 'session-123' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'list_messages', inputSchema: { type: 'object' } }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await fetchToolsHttp(makeServer({
      headers: {
        Authorization: 'Bearer token',
        'X-API-Key': 'secret',
      },
    }))

    for (const [, init] of fetchMock.mock.calls) {
      const headers = (init as RequestInit).headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer token')
      expect(headers['X-API-Key']).toBe('secret')
      expect(headers['Content-Type']).toBe('application/json')
      expect(headers['Accept']).toBe('application/json')
    }
  })

  it('sends streamable-http accept headers expected by remote MCP servers', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-123' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 202,
        headers: { 'Mcp-Session-Id': 'session-123' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'resolve-library-id', inputSchema: { type: 'object' } }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await fetchToolsHttp(makeServer({ transport: 'streamable-http' }))

    for (const [, init] of fetchMock.mock.calls) {
      const headers = (init as RequestInit).headers as Record<string, string>
      expect(headers['Accept']).toBe('application/json, text/event-stream')
    }
  })

  it('injects bearer credentials from an environment variable and trims surrounding whitespace', async () => {
    process.env['TEST_MCP_BEARER_TOKEN'] = '  example-token  '
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-123' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 202,
        headers: { 'Mcp-Session-Id': 'session-123' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'list_messages', inputSchema: { type: 'object' } }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await fetchToolsHttp(makeServer({
      auth: {
        mode: 'bearer',
        source: { type: 'env', envVar: 'TEST_MCP_BEARER_TOKEN' },
      },
    }))

    for (const [, init] of fetchMock.mock.calls) {
      const headers = (init as RequestInit).headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer example-token')
    }
  })

  it('marks bearer auth as rejected when the downstream returns HTTP 401', async () => {
    process.env['TEST_MCP_BEARER_TOKEN'] = 'example-token'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const server = makeServer({
      auth: {
        mode: 'bearer',
        source: { type: 'env', envVar: 'TEST_MCP_BEARER_TOKEN' },
      },
    })
    downstreamAuthManager.syncServers([server])

    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="example-mcp"' },
      }),
    )

    await expect(fetchToolsHttp(server)).rejects.toThrow('returned HTTP 401')

    const state = await downstreamAuthManager.getState(server.id)
    expect(state.status).toBe(DownstreamAuthStatus.AuthRequired)
    expect(state.message).toBe('Downstream server rejected the configured bearer credentials')
  })

  it('fails clearly when tools/list does not return result.tools', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 202,
        headers: { 'Mcp-Session-Id': 'session-123' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(fetchToolsHttp(makeServer())).rejects.toThrow('response missing result.tools')
  })

  it('accepts initialize and tools/list responses delivered via SSE for streamable-http', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(
      sseResponse(
        {
          jsonrpc: '2.0',
          id: 1,
          result: { capabilities: {} },
        },
        { 'Mcp-Session-Id': 'session-sse' },
      ),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 202,
        headers: { 'Mcp-Session-Id': 'session-sse' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'SearchFastMcp', inputSchema: { type: 'object' } }] },
      }),
    )

    const tools = await fetchToolsHttp(makeServer({ transport: 'streamable-http' }))

    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('SearchFastMcp')
  })

  it('fails clearly when an SSE stream never returns the matching JSON-RPC response', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: '2.0',
        id: 999,
        result: { capabilities: {} },
      }),
    )

    await expect(fetchToolsHttp(makeServer({ transport: 'streamable-http' }))).rejects.toThrow(
      'SSE stream ended without a matching JSON-RPC response for initialize',
    )
  })

  it('fails clearly when an SSE event contains invalid JSON', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(
      new Response('event: message\ndata: {not-json}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )

    await expect(fetchToolsHttp(makeServer({ transport: 'streamable-http' }))).rejects.toThrow(
      'returned invalid JSON in SSE event',
    )
  })

  it('sends notifications/initialized before tools/call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-456' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 202,
        headers: { 'Mcp-Session-Id': 'session-456' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const response = await callToolHttp(makeServer(), 'list_messages', { query: 'test' })

    expect(response).toEqual({ result: { content: [] }, error: undefined })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const initializedRequest = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(initializedRequest.body).toContain('"method":"notifications/initialized"')
    expect((initializedRequest.headers as Record<string, string>)['Mcp-Session-Id']).toBe(
      'session-456',
    )

    const callRequest = fetchMock.mock.calls[2]?.[1] as RequestInit
    expect(callRequest.body).toContain('"method":"tools/call"')
    expect((callRequest.headers as Record<string, string>)['Mcp-Session-Id']).toBe('session-456')
  })

  it('accepts tools/call responses delivered via SSE for streamable-http', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(
      sseResponse(
        {
          jsonrpc: '2.0',
          id: 1,
          result: { capabilities: {} },
        },
        { 'Mcp-Session-Id': 'session-789' },
      ),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 202,
        headers: { 'Mcp-Session-Id': 'session-789' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: 'From SSE' }] },
      }),
    )

    const response = await callToolHttp(
      makeServer({ transport: 'streamable-http' }),
      'SearchFastMcp',
      { query: 'deploy' },
    )

    expect(response).toEqual({
      result: { content: [{ type: 'text', text: 'From SSE' }] },
      error: undefined,
    })
  })
})
