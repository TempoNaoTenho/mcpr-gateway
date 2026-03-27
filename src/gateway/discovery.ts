import type { VisibleTool } from '../types/tools.js'
import type { SessionState } from '../types/session.js'
import { GatewayMode, ToolRiskLevel } from '../types/enums.js'
import { generateToolcards } from '../toolcard/index.js'
import type { IRegistryAdapter } from '../types/interfaces.js'
import { toolCandidateKey } from '../candidate/lexical.js'
import { getConfig } from '../config/index.js'
import { disabledToolKeysForNamespace } from '../config/disabled-tool-keys.js'
import { rankToolsWithBm25 } from '../selector/bm25.js'
import { GATEWAY_SERVER_ID } from './gateway-constants.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GATEWAY_SEARCH_TOOL_NAME = 'gateway_search_tools'
export const GATEWAY_CALL_TOOL_NAME = 'gateway_call_tool'
export const GATEWAY_RUN_CODE_TOOL_NAME = 'gateway_run_code'
export const GATEWAY_HELP_TOOL_NAME = 'gateway_help'
export { GATEWAY_SERVER_ID }

/** @deprecated Use GATEWAY_SERVER_ID */
export const GATEWAY_DISCOVERY_SERVER_ID = GATEWAY_SERVER_ID

// ---------------------------------------------------------------------------
// Type guard — identifies any gateway-internal tool
// ---------------------------------------------------------------------------

const GATEWAY_TOOL_NAMES = new Set([
  GATEWAY_SEARCH_TOOL_NAME,
  GATEWAY_CALL_TOOL_NAME,
  GATEWAY_RUN_CODE_TOOL_NAME,
  GATEWAY_HELP_TOOL_NAME,
])

export function isGatewayInternalTool(toolName: string, serverId?: string): boolean {
  return GATEWAY_TOOL_NAMES.has(toolName) || serverId === GATEWAY_SERVER_ID
}

/** @deprecated Use isGatewayInternalTool */
export const isGatewayDiscoveryTool = isGatewayInternalTool

// ---------------------------------------------------------------------------
// Gateway tool definitions
// ---------------------------------------------------------------------------

function buildGatewaySearchTool(namespace: string): VisibleTool {
  return {
    name: GATEWAY_SEARCH_TOOL_NAME,
    description: `Find tools by keyword across all connected servers. Returns matches ranked by relevance, each with a name and serverId.
      Use gateway_call_tool with the exact returned name+serverId to execute a match. Do not guess aliases or historical tool names.
      Tips: use 2–3 distinctive words ("github list issues"); if no matches, try fewer words ("github issues").`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Terms matched against tool name, description, and tags; prefer short, distinctive tokens (e.g product or integration name).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description:
            'Max hits (1-10, default 5); lower values keep responses smaller; increase if you get no matches and the namespace has many tools.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    serverId: GATEWAY_SERVER_ID,
    namespace,
    riskLevel: ToolRiskLevel.Low,
    tags: ['search', 'discovery'],
  }
}

function buildGatewayCallTool(namespace: string): VisibleTool {
  return {
    name: GATEWAY_CALL_TOOL_NAME,
    description:
      'Execute a named tool by providing its exact name and serverId as returned by gateway_search_tools. Do not substitute aliases or historical tool names.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact tool name as returned by gateway_search_tools.',
        },
        serverId: {
          type: 'string',
          description: 'Exact server ID as returned by gateway_search_tools.',
        },
        arguments: { type: 'object', description: 'Arguments to pass to the tool.', default: {} },
      },
      required: ['name', 'serverId'],
      additionalProperties: false,
    },
    serverId: GATEWAY_SERVER_ID,
    namespace,
    riskLevel: ToolRiskLevel.Low,
    tags: ['execution', 'proxy'],
  }
}

function buildGatewayRunCodeTool(namespace: string): VisibleTool {
  return {
    name: GATEWAY_RUN_CODE_TOOL_NAME,
    description: `Execute JavaScript in the gateway sandbox to orchestrate multiple tools in one call.
      Workflow:
        catalog.search(q, { k | limit, serverId, requiredArgs }) / catalog.list({ serverId, requiredArgs }) — discover tools, returns session-scoped handles
        catalog.describe(handle, { detail: "signature" }) — inspect required args and short field metadata before execution
        mcp.call(handle, args) / mcp.batch([...])  — execute one or many tools with handles from this execution
        result.pick/limit/items/text/grep/groupBy/summarize() — transform output
        artifacts.save(data)                       — store oversized results
      Always await async calls. Call gateway_help for the full API reference and examples.`,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript to execute. Available globals: catalog, mcp, result, artifacts. `result` is reserved and should not be redeclared. Simple expressions like `1 + 1` work without `return`. For multi-line statements, use `return` for the final value. `catalog.search()` accepts `k`, compatibility alias `limit` (prefer `k`), and optional filters such as `serverId` and `requiredArgs`. `catalog.describe(..., { detail: "signature" })` exposes required fields plus short property metadata. Prefer `result.items()` or `result.text()` when tools return content blocks. Prefer `catalog.describe()` before `mcp.batch()` when mixing tools. Always await async calls and return serializable JSON-friendly data.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    serverId: GATEWAY_SERVER_ID,
    namespace,
    riskLevel: ToolRiskLevel.Low,
    tags: ['runtime', 'code', 'execution'],
  }
}

function buildGatewayHelpTool(namespace: string): VisibleTool {
  return {
    name: GATEWAY_HELP_TOOL_NAME,
    description:
      'Return the gateway_run_code runtime API reference with usage examples. Call this when unsure about catalog, mcp, result, or artifacts method signatures.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['catalog', 'mcp', 'result', 'artifacts', 'all'],
          description: 'Optional help topic to return.',
        },
      },
      additionalProperties: false,
    },
    serverId: GATEWAY_SERVER_ID,
    namespace,
    riskLevel: ToolRiskLevel.Low,
    tags: ['runtime', 'help'],
  }
}

/**
 * Returns the gateway tool window — only the two meta-tools.
 * Always active, no config toggle required.
 */
export function buildGatewayToolWindow(namespace: string): VisibleTool[] {
  return [buildGatewaySearchTool(namespace), buildGatewayCallTool(namespace)]
}

export function buildCodeModeToolWindow(namespace: string): VisibleTool[] {
  return [buildGatewayRunCodeTool(namespace), buildGatewayHelpTool(namespace)]
}

export function buildGatewayToolWindowForMode(
  namespace: string,
  gatewayMode: GatewayMode = GatewayMode.Compat
): VisibleTool[] {
  if (gatewayMode === GatewayMode.Code) {
    return buildCodeModeToolWindow(namespace)
  }
  return buildGatewayToolWindow(namespace)
}

// ---------------------------------------------------------------------------
// gateway_search_tools argument parsing
// ---------------------------------------------------------------------------

type SearchArgs = {
  query?: string
  limit?: number
}

function parseSearchArgs(args: unknown): Required<SearchArgs> {
  const parsed =
    args && typeof args === 'object' && !Array.isArray(args) ? (args as SearchArgs) : {}
  return {
    query: typeof parsed.query === 'string' ? parsed.query.trim() : '',
    limit: Math.max(1, Math.min(10, typeof parsed.limit === 'number' ? parsed.limit : 5)),
  }
}

export async function executeGatewaySearch(
  session: SessionState,
  args: unknown,
  registry: IRegistryAdapter
): Promise<{ result: unknown }> {
  const parsed = parseSearchArgs(args)
  const serverGroups = registry.getToolsByNamespace?.(session.namespace) ?? []
  const toolcards = serverGroups.flatMap(({ server, records }) =>
    generateToolcards(records, server, server.toolOverrides)
  )
  const disabledKeys = disabledToolKeysForNamespace(getConfig(), session.namespace)

  const searchable = toolcards
    .filter((tc) => !tc.quarantined)
    .filter((tc) => !disabledKeys.has(toolCandidateKey(tc.serverId, tc.name)))

  const matches = rankToolsWithBm25(searchable, parsed.query)
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      const diff = b.score - a.score
      if (diff !== 0) return diff
      return a.toolcard.name.localeCompare(b.toolcard.name)
    })
    .slice(0, parsed.limit)

  return {
    result: {
      query: parsed.query,
      matches: matches.map(({ toolcard, score, matchedTerms }) => ({
        name: toolcard.name,
        serverId: toolcard.serverId,
        description: toolcard.description,
        score,
        matchedTerms,
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// gateway_call_tool argument parsing
// ---------------------------------------------------------------------------

export type GatewayCallArgs = {
  name: string
  serverId: string
  arguments: Record<string, unknown>
}

export type GatewayRunCodeArgs = {
  code: string
}

export function parseGatewayCallArgs(args: unknown): GatewayCallArgs | { error: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { error: 'Arguments must be an object with name and serverId' }
  }
  const obj = args as Record<string, unknown>
  if (typeof obj.name !== 'string' || !obj.name) {
    return { error: 'Missing required field: name' }
  }
  if (typeof obj.serverId !== 'string' || !obj.serverId) {
    return { error: 'Missing required field: serverId' }
  }
  const toolArgs = obj.arguments ?? {}
  if (typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
    return { error: 'Field arguments must be an object' }
  }
  return {
    name: obj.name,
    serverId: obj.serverId,
    arguments: toolArgs as Record<string, unknown>,
  }
}

export function parseGatewayRunCodeArgs(args: unknown): GatewayRunCodeArgs | { error: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { error: 'Arguments must be an object with code' }
  }
  const obj = args as Record<string, unknown>
  if (typeof obj.code !== 'string' || obj.code.trim().length === 0) {
    return { error: 'Missing required field: code' }
  }
  return { code: obj.code }
}
