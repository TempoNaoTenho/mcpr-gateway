import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRealUsageBenchmarkFixture } from '../../bench/fixtures/real-usage-benchmark.js'
import { BenchmarkMcpClient } from '../../bench/lib/mcp-client.js'
import { createBenchmarkRuntime } from '../../bench/lib/runtime.js'

type SearchProbe = {
  expectedTool: string
  expectedServerId: string
  query: string
}

const probes: Record<string, SearchProbe> = {
  web: {
    expectedTool: 'search_web',
    expectedServerId: 'web-search',
    query: 'search web',
  },
  fetch: {
    expectedTool: 'fetch_markdown',
    expectedServerId: 'fetch-hub',
    query: 'fetch markdown',
  },
  fastmcp: {
    expectedTool: 'search_fastmcp_docs',
    expectedServerId: 'fastmcp-docs',
    query: 'fastmcp docs',
  },
  context7: {
    expectedTool: 'resolve_library_reference',
    expectedServerId: 'context7-docs',
    query: 'resolve library reference',
  },
  supabase: {
    expectedTool: 'list_tables',
    expectedServerId: 'supabase-db',
    query: 'list tables supabase',
  },
  cloudflare: {
    expectedTool: 'search_cloudflare_docs',
    expectedServerId: 'cloudflare-docs',
    query: 'cloudflare docs',
  },
}

let fixture: Awaited<ReturnType<typeof createRealUsageBenchmarkFixture>> | undefined
let runtime: Awaited<ReturnType<typeof createBenchmarkRuntime>> | undefined

function readSearchMatches(payload: unknown): Array<{ name: string; serverId: string }> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const structuredContent = (payload as { structuredContent?: unknown }).structuredContent
  if (!structuredContent || typeof structuredContent !== 'object' || Array.isArray(structuredContent)) {
    return []
  }
  const matches = (structuredContent as { matches?: unknown }).matches
  return Array.isArray(matches) ? (matches as Array<{ name: string; serverId: string }>) : []
}

beforeAll(async () => {
  fixture = await createRealUsageBenchmarkFixture()
  runtime = await createBenchmarkRuntime(fixture.configDir)
})

afterAll(async () => {
  if (runtime) await runtime.close()
  if (fixture) await fixture.close()
})

describe('gateway_search_tools over real MCP flows (real_usage_benchmark fixture)', () => {
  it('finds relevant tools for distinct search queries', async () => {
    if (!runtime || !fixture) throw new Error('Test setup failed - runtime or fixture undefined')

    const runtimeRef = runtime
    const client = new BenchmarkMcpClient(
      (input) => runtimeRef.app.inject(input),
      'research',
      fixture.authHeader
    )

    const { sessionId } = await client.initialize('read')

    const tools = await client.toolsList(sessionId)
    expect(tools.map((t) => t.name)).toContain('gateway_search_tools')
    expect(tools.map((t) => t.name)).toContain('gateway_call_tool')
    expect(tools.map((t) => t.name)).toContain('gateway_list_servers')
    expect(tools).toHaveLength(3)

    for (const [label, probe] of Object.entries(probes)) {
      const searchResult = await client.callTool(sessionId, 'gateway_search_tools', {
        query: probe.query,
        limit: 10,
      })

      const matches = readSearchMatches(searchResult)
      const found = matches.some(
        (m) => m.name === probe.expectedTool && m.serverId === probe.expectedServerId
      )
      expect(
        found,
        `${label}: expected ${probe.expectedTool} in search results for "${probe.query}"`
      ).toBe(true)
    }
  }, 30_000)
})
