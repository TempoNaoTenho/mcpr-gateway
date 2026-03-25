import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultDebug,
  defaultResilience,
  defaultSelector,
  defaultSession,
  defaultTriggers,
} from '../../test/fixtures/bootstrap-json.js'
import { createFixtureMcpServer } from './fake-mcp.js'

export async function createRealUsageBenchmarkFixture() {
  const webSearch = await createFixtureMcpServer([
    {
      name: 'search_web',
      description: 'Search the public web for pages, news, docs, and articles',
    },
    {
      name: 'open_search_result',
      description: 'Open a web search result by id and inspect the page',
    },
    {
      name: 'extract_web_page',
      description: 'Fetch a public web page and extract readable text content',
    },
  ])

  const fetchTools = await createFixtureMcpServer([
    { name: 'fetch_url', description: 'Fetch a URL and return the raw response body' },
    { name: 'fetch_json', description: 'Fetch a JSON API endpoint and return parsed JSON' },
    { name: 'fetch_markdown', description: 'Fetch a markdown document or README from a URL' },
  ])

  const fastmcpDocs = await createFixtureMcpServer([
    {
      name: 'search_fastmcp_docs',
      description: 'Search FastMCP documentation, examples, and guides',
    },
    { name: 'read_fastmcp_doc', description: 'Read one FastMCP documentation page by id' },
    {
      name: 'list_fastmcp_examples',
      description: 'List FastMCP examples, recipes, and starter projects',
    },
  ])

  const context7Docs = await createFixtureMcpServer([
    {
      name: 'resolve_library_reference',
      description: 'Resolve a package or library name to the canonical Context7 reference',
    },
    {
      name: 'get_library_docs',
      description: 'Read Context7 library docs for a resolved package reference',
    },
    {
      name: 'search_context7_docs',
      description: 'Search Context7 indexed library documentation by topic',
    },
  ])

  const supabaseDb = await createFixtureMcpServer([
    { name: 'list_tables', description: 'List PostgreSQL tables from the Supabase database' },
    {
      name: 'describe_table',
      description: 'Return columns, keys, and types for one Supabase table',
    },
    {
      name: 'query_postgres',
      description: 'Run a read-only SQL query against the Supabase Postgres database',
    },
  ])

  const cloudflareDocs = await createFixtureMcpServer([
    {
      name: 'search_cloudflare_docs',
      description: 'Search Cloudflare product documentation and platform guides',
    },
    { name: 'read_cloudflare_doc', description: 'Read one Cloudflare documentation page by id' },
    {
      name: 'list_cloudflare_products',
      description: 'List Cloudflare products, services, and platform areas',
    },
  ])

  const configDir = mkdtempSync(join(tmpdir(), 'mcp-gateway-bench-real-usage-'))
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'bootstrap.json'),
    JSON.stringify(
      {
        servers: [
          {
            id: 'web-search',
            namespaces: ['research'],
            transport: 'streamable-http',
            url: webSearch.url,
            enabled: true,
            trustLevel: 'internal',
          },
          {
            id: 'fetch-hub',
            namespaces: ['research'],
            transport: 'streamable-http',
            url: fetchTools.url,
            enabled: true,
            trustLevel: 'internal',
          },
          {
            id: 'fastmcp-docs',
            namespaces: ['research'],
            transport: 'streamable-http',
            url: fastmcpDocs.url,
            enabled: true,
            trustLevel: 'internal',
          },
          {
            id: 'context7-docs',
            namespaces: ['research'],
            transport: 'streamable-http',
            url: context7Docs.url,
            enabled: true,
            trustLevel: 'internal',
          },
          {
            id: 'supabase-db',
            namespaces: ['research'],
            transport: 'streamable-http',
            url: supabaseDb.url,
            enabled: true,
            trustLevel: 'internal',
          },
          {
            id: 'cloudflare-docs',
            namespaces: ['research'],
            transport: 'streamable-http',
            url: cloudflareDocs.url,
            enabled: true,
            trustLevel: 'internal',
          },
        ],
        auth: { mode: 'static_key' },
        namespaces: {
          research: {
            allowedRoles: ['user', 'admin'],
            bootstrapWindowSize: 4,
            candidatePoolSize: 18,
            allowedModes: ['read', 'write'],
          },
        },
        roles: {
          user: {
            allowNamespaces: ['research'],
            denyModes: ['admin'],
          },
          admin: {
            allowNamespaces: ['research'],
          },
        },
        selector: defaultSelector,
        session: defaultSession,
        triggers: defaultTriggers,
        resilience: defaultResilience,
        debug: {
          ...defaultDebug,
          enabled: true,
        },
        starterPacks: {
          research: {
            preferredTags: ['web', 'fetch', 'docs', 'database', 'search'],
            maxTools: 6,
            includeRiskLevels: ['low', 'medium'],
            includeModes: ['read', 'write'],
          },
        },
      },
      null,
      2
    )
  )

  return {
    configDir,
    authHeader: 'Bearer benchmark:user',
    async close() {
      await Promise.all([
        webSearch.close(),
        fetchTools.close(),
        fastmcpDocs.close(),
        context7Docs.close(),
        supabaseDb.close(),
        cloudflareDocs.close(),
      ])
      rmSync(configDir, { recursive: true, force: true })
    },
  }
}
