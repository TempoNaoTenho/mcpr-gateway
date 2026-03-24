import type { SelectorConfig } from '../config/schemas.js'
import type { VisibleTool } from '../types/tools.js'
import type { SessionState } from '../types/session.js'
import { GatewayMode, RefreshTriggerType, ToolRiskLevel } from '../types/enums.js'
import { generateToolcards } from '../toolcard/index.js'
import type { IRegistryAdapter } from '../types/interfaces.js'
import { toolCandidateKey } from '../candidate/lexical.js'
import { projectToPublic } from './publish/project.js'
import { inferCapabilityFromTool } from '../selector/focus.js'
import { getConfig } from '../config/index.js'
import { disabledToolKeysForNamespace } from '../config/disabled-tool-keys.js'
import { rankToolsWithBm25 } from '../selector/bm25.js'
import { GATEWAY_SERVER_ID } from './gateway-constants.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GATEWAY_DISCOVERY_TOOL_NAME = 'gateway_find_tools'
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
  GATEWAY_DISCOVERY_TOOL_NAME,
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
      Use gateway_call_tool with the returned name+serverId to execute a match.
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
      'Execute a named tool by providing its name and serverId. Use gateway_search_tools first to discover available tools and obtain their name and serverId.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name as returned by gateway_search_tools.' },
        serverId: { type: 'string', description: 'Server ID as returned by gateway_search_tools.' },
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
        catalog.search(q) / catalog.list()         — discover tools, returns handles
        mcp.call(handle, args) / mcp.batch([...])  — execute one or many tools
        result.pick/limit/grep/groupBy/summarize() — transform output
        artifacts.save(data)                       — store oversized results
      Always await async calls. Call gateway_help for the full API reference and examples.`,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript to execute. Available globals: catalog, mcp, result, artifacts. Always await async calls. Return a value directly or call artifacts.save() for large data.',
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

// ---------------------------------------------------------------------------
// Legacy: gateway_find_tools (BM25-based, kept for backward compat)
// ---------------------------------------------------------------------------

type DiscoveryArgs = {
  query?: string
  limit?: number
  promoteCount?: number
  includeVisible?: boolean
}

function getDiscoveryConfig(
  selectorConfig: SelectorConfig
): Required<SelectorConfig>['discoveryTool'] {
  return (
    selectorConfig.discoveryTool ?? {
      enabled: false,
      resultLimit: 8,
      promoteCount: 3,
    }
  )
}

function buildGatewayDiscoveryTool(namespace: string): VisibleTool {
  return {
    name: GATEWAY_DISCOVERY_TOOL_NAME,
    description:
      'Search hidden tools in this namespace and promote the best matches into the session window.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'BM25/lexical search query for hidden tools.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Maximum results to inspect.',
        },
        promoteCount: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: 'How many matching tools should be promoted into the active session window.',
        },
        includeVisible: {
          type: 'boolean',
          description: 'Include tools already visible in the current session window.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    serverId: GATEWAY_SERVER_ID,
    namespace,
    riskLevel: ToolRiskLevel.Low,
    tags: ['search', 'discovery', namespace],
  }
}

export function appendDiscoveryTool(
  tools: VisibleTool[],
  namespace: string,
  selectorConfig: SelectorConfig
): VisibleTool[] {
  const discoveryConfig = getDiscoveryConfig(selectorConfig)
  if (!discoveryConfig.enabled) return tools
  if (
    tools.some(
      (tool) => tool.serverId === GATEWAY_SERVER_ID && tool.name === GATEWAY_DISCOVERY_TOOL_NAME
    )
  ) {
    return tools
  }
  return [...tools, buildGatewayDiscoveryTool(namespace)]
}

function parseDiscoveryArgs(
  args: unknown,
  selectorConfig: SelectorConfig
): Required<DiscoveryArgs> {
  const discoveryConfig = getDiscoveryConfig(selectorConfig)
  const parsed =
    args && typeof args === 'object' && !Array.isArray(args) ? (args as DiscoveryArgs) : {}
  return {
    query: typeof parsed.query === 'string' ? parsed.query.trim() : '',
    limit: Math.max(1, Math.min(20, parsed.limit ?? discoveryConfig.resultLimit)),
    promoteCount: Math.max(1, Math.min(10, parsed.promoteCount ?? discoveryConfig.promoteCount)),
    includeVisible: parsed.includeVisible === true,
  }
}

function promoteHiddenTools(session: SessionState, promoted: VisibleTool[]): VisibleTool[] {
  const discoveryTool = session.toolWindow.find((tool) =>
    isGatewayInternalTool(tool.name, tool.serverId)
  )
  const visible = session.toolWindow.filter(
    (tool) => !isGatewayInternalTool(tool.name, tool.serverId)
  )
  const deduped = [...visible]

  for (const tool of promoted) {
    if (!deduped.some((entry) => entry.serverId === tool.serverId && entry.name === tool.name)) {
      deduped.push(tool)
    }
  }

  return discoveryTool ? [...deduped, discoveryTool] : deduped
}

export async function executeGatewayDiscovery(
  session: SessionState,
  args: unknown,
  registry: IRegistryAdapter,
  selectorConfig: SelectorConfig
): Promise<{ updatedSession: SessionState; result: unknown }> {
  const parsed = parseDiscoveryArgs(args, selectorConfig)
  const serverGroups = registry.getToolsByNamespace?.(session.namespace) ?? []
  const toolcards = serverGroups.flatMap(({ server, records }) =>
    generateToolcards(records, server, server.toolOverrides)
  )
  const disabledKeys = disabledToolKeysForNamespace(getConfig(), session.namespace)
  const visibleKeys = new Set(session.toolWindow.map((tool) => `${tool.serverId}::${tool.name}`))

  const searchableToolcards = toolcards
    .filter((toolcard) => !disabledKeys.has(toolCandidateKey(toolcard.serverId, toolcard.name)))
    .filter(
      (toolcard) =>
        parsed.includeVisible || !visibleKeys.has(`${toolcard.serverId}::${toolcard.name}`)
    )

  const ranked = rankToolsWithBm25(searchableToolcards, parsed.query)
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      const diff = right.score - left.score
      if (diff !== 0) return diff
      return left.toolcard.name.localeCompare(right.toolcard.name)
    })

  const matches = ranked.slice(0, parsed.limit)
  const promoted = matches
    .slice(0, Math.min(parsed.promoteCount, matches.length))
    .map(({ toolcard }) => ({
      name: toolcard.name,
      description: toolcard.description,
      inputSchema: toolcard.inputSchema,
      serverId: toolcard.serverId,
      namespace: toolcard.namespace,
      riskLevel: toolcard.riskLevel,
      tags: toolcard.tags,
    }))

  const nextToolWindow = promoteHiddenTools(session, promoted)
  const updatedSession: SessionState = {
    ...session,
    toolWindow: nextToolWindow,
    refreshCount: session.refreshCount + (promoted.length > 0 ? 1 : 0),
    pendingToolListChange: promoted.length > 0,
    refreshHistory:
      promoted.length > 0
        ? [
            ...(session.refreshHistory ?? []),
            {
              triggeredBy: RefreshTriggerType.ExplicitRequest,
              timestamp: new Date().toISOString(),
              toolCount: nextToolWindow.length,
            },
          ]
        : (session.refreshHistory ?? []),
  }

  return {
    updatedSession,
    result: {
      query: parsed.query,
      promoted: promoted.map((tool) => ({ name: tool.name, serverId: tool.serverId })),
      matches: matches.map(({ toolcard, score }) => ({
        name: toolcard.name,
        serverId: toolcard.serverId,
        namespace: toolcard.namespace,
        capability: inferCapabilityFromTool(toolcard),
        score,
        search: {
          strategy: 'bm25',
        },
        tool: projectToPublic(toolcard, selectorConfig),
      })),
    },
  }
}
