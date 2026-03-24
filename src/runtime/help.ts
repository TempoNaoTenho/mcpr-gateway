import { GatewayMode } from '../types/enums.js'

const HELP_TOPICS: Record<string, string> = {
  catalog: [
    'catalog.search(query, { k, detail })',
    '  query: natural language search for tools',
    '  k: number of results (default 5)',
    '  detail: name | summary | signature | full',
    'catalog.list({ risk, tags, limit, detail })',
    '  risk: filter by risk level (Low, Medium, High)',
    '  tags: filter by capability tags',
    '  limit: max results',
    'catalog.describe(handle, { detail, fields })',
    '  handle: tool handle from search/list results',
    '  detail: name | summary | signature | full',
    '',
    'Example:',
    '  const tools = await catalog.search("github pull request comments", { k: 3 })',
    '  const details = await catalog.describe(tools[0].handle, { detail: "signature" })',
  ].join('\n'),
  mcp: [
    'mcp.call(handle, args)',
    '  handle: tool handle from catalog.search() or catalog.list()',
    '  args: tool-specific arguments object',
    'mcp.batch([{ handle, args }, ...])',
    '  Execute multiple tool calls in parallel',
    '',
    'Example:',
    '  const prs = await catalog.search("list open prs", { k: 1 })',
    '  const rows = await mcp.call(prs[0].handle, { owner: "org", repo: "repo" })',
  ].join('\n'),
  result: [
    'result.pick(value, fields)',
    '  Extract specific fields from objects',
    'result.limit(array, n)',
    '  Return first n items',
    'result.count(value)',
    '  Count items in array or object keys',
    'result.groupBy(array, field)',
    '  Group array items by field value',
    'result.grep(array, field, pattern)',
    '  Filter by field matching regex pattern',
    'result.flatten(array, depth)',
    '  Flatten nested arrays',
    'result.summarize(value)',
    '  Generate concise summary of any value',
    '',
    'Example:',
    '  return result.limit(result.pick(rows, ["number", "title", "state"]), 10)',
  ].join('\n'),
  artifacts: [
    'artifacts.save(data, { label })',
    '  Save data for later reference (use for large results)',
    '  label: optional human-readable label',
    'artifacts.list()',
    '  List all saved artifacts in this session',
    '',
    'Large results should be saved and referenced instead of returned in full.',
  ].join('\n'),
}

const MODE_GUIDANCE: Record<string, string[]> = {
  [GatewayMode.Compat]: [
    '',
    '═══════════════════════════════════════════════════════════',
    'COMPAT MODE — Use gateway_search_tools and gateway_call_tool',
    '═══════════════════════════════════════════════════════════',
    '',
    '1. DISCOVER TOOLS: Use gateway_search_tools with a query',
    '   Example: gateway_search_tools({ query: "github issues" })',
    '',
    '2. CALL TOOLS: Use gateway_call_tool with handle and args',
    '   Example: gateway_call_tool({',
    '     handle: "github__list_issues",',
    '     args: { owner: "org", repo: "repo" }',
    '   })',
    '',
    '3. TOOL HANDLES: Discovered via gateway_search_tools results',
    '',
    'ERROR RECOVERY: If a tool call fails, try:',
    '  - Check handle spelling matches gateway_search_tools output',
    '  - Verify args match tool signature from catalog.describe()',
    '  - Retry with simplified arguments',
  ],
  [GatewayMode.Code]: [
    '',
    '═══════════════════════════════════════════════════════════',
    'CODE MODE — Use gateway_run_code with runtime APIs',
    '═══════════════════════════════════════════════════════════',
    '',
    '1. DISCOVER: catalog.search() or catalog.list()',
    '   Returns tool handles for use with mcp.call()',
    '',
    '2. EXECUTE: mcp.call(handle, args) or mcp.batch([...])',
    '   Execute discovered tools with arguments',
    '',
    '3. SHAPE: result.* functions to transform output',
    '   pick(), limit(), grep(), groupBy(), summarize()',
    '',
    '4. RETURN: Use result.limit() to keep responses small',
    '   For large data, use artifacts.save() instead',
    '',
    'ERROR RECOVERY: If execution fails, check:',
    '  - Tool handle exists: await catalog.search("name")',
    '  - Args match signature: await catalog.describe(handle, { detail: "signature" })',
    '  - Async/await: Always await mcp.call() and catalog.*()',
  ],
}

const COMMON_ERRORS = [
  '',
  '═══════════════════════════════════════════════════════════',
  'COMMON ERRORS AND RECOVERY',
  '═══════════════════════════════════════════════════════════',
  '',
  '• "Tool not found": Use catalog.search() to find correct handle',
  '• "Invalid arguments": Check catalog.describe() for expected args',
  '• "Permission denied": Contact admin to enable tool for namespace',
  '• "Rate limited": Wait and retry with fewer requests (use mcp.batch)',
  '• "Connection failed": Downstream server may be unavailable',
]

export function buildGatewayHelp(
  topic?: string,
  gatewayMode: GatewayMode = GatewayMode.Code
): { topic: string; text: string } {
  const modeHeader = [
    '─────────────────────────────────────────────────────────────',
    `Active Mode: ${gatewayMode}`,
    '─────────────────────────────────────────────────────────────',
  ].join('\n')

  const modeSection = MODE_GUIDANCE[gatewayMode]?.join('\n') ?? ''

  if (!topic || topic === 'all') {
    return {
      topic: 'all',
      text: [
        modeHeader,
        '',
        'gateway_run_code runtime API',
        '',
        HELP_TOPICS['catalog'],
        '',
        HELP_TOPICS['mcp'],
        '',
        HELP_TOPICS['result'],
        '',
        HELP_TOPICS['artifacts'],
        modeSection,
        ...COMMON_ERRORS,
      ].join('\n'),
    }
  }

  return {
    topic,
    text: [modeHeader, HELP_TOPICS[topic] ?? HELP_TOPICS['catalog'], modeSection].join('\n'),
  }
}
