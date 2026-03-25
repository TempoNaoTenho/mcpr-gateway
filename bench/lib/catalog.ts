import { buildAdminToolEntry, estimateSerializedTokens } from '../../src/admin/catalog.js'
import { resolveIdentity } from '../../src/auth/index.js'
import { applyHardFilters } from '../../src/candidate/filters.js'
import { disabledToolKeysForNamespace } from '../../src/config/disabled-tool-keys.js'
import { getConfig } from '../../src/config/index.js'
import { projectToPublic } from '../../src/gateway/publish/project.js'
import { resolvePolicy } from '../../src/policy/index.js'
import { generateToolcards } from '../../src/toolcard/index.js'
import { DownstreamHealth, Mode, ToolRiskLevel } from '../../src/types/enums.js'
import type { DownstreamRegistry } from '../../src/registry/registry.js'
import type { DownstreamServer } from '../../src/types/server.js'
import type { PublicTool, Toolcard, VisibleTool } from '../../src/types/tools.js'
import { rankByBm25 } from '../../src/selector/bm25.js'
import type { BenchmarkScenario, ToolExposure } from '../types.js'

type RankedTool = VisibleTool & { description?: string }
type ScenarioContext = Pick<BenchmarkScenario, 'namespace' | 'mode' | 'authHeader'> & {
  id?: string
  prompt?: string
}

export async function buildBaselineExposure(
  registry: DownstreamRegistry,
  scenario: ScenarioContext,
): Promise<{ tools: VisibleTool[]; publicTools: PublicTool[]; totalTokens: number }> {
  const config = getConfig()
  const authHeader = scenario.authHeader ?? 'Bearer benchmark:user'
  const identity = resolveIdentity(authHeader, config.auth)
  const decision = resolvePolicy(identity, scenario.namespace, scenario.mode ?? Mode.Read, config)
  if (!decision.allowed) {
    throw new Error(`Scenario ${scenario.id ?? scenario.prompt ?? scenario.namespace} is not allowed by current policy`)
  }

  const starterPackKey = decision.starterPackKey
  const starterPack = starterPackKey ? config.starterPacks[starterPackKey] : undefined
  const includeRiskLevels = starterPack?.includeRiskLevels ?? [ToolRiskLevel.Low]
  const healthStates = registry.getHealthStates()
  const disabledToolKeys = disabledToolKeysForNamespace(config, scenario.namespace)
  const toolcards = registry.getToolsByNamespace(scenario.namespace)
    .flatMap(({ server, records }) => generateToolcards(records, server, server.toolOverrides))

  const { passed } = applyHardFilters(toolcards, {
    namespace: scenario.namespace,
    mode: scenario.mode ?? Mode.Read,
    candidatePoolSize: toolcards.length,
    currentToolWindow: [],
    recentOutcomes: [],
    starterPackHints: starterPack?.preferredTags ?? [],
    includeRiskLevels,
    allToolcards: toolcards,
    healthStates,
    disabledToolKeys,
  })

  const visibleTools = passed.map(toVisibleTool)
  const publicTools = visibleTools.map((tool) => projectToPublic(tool, config.selector))
  return {
    tools: visibleTools,
    publicTools,
    totalTokens: estimateSerializedTokens(publicTools),
  }
}

export function rankVisibleToolsForPrompt(
  tools: VisibleTool[],
  prompt: string,
): VisibleTool[] {
  const ranked = rankByBm25(
    tools,
    prompt,
    (tool) => [tool.name, tool.description, tool.tags.join(' '), tool.serverId].filter(Boolean).join(' '),
    (left, right) => left.name.localeCompare(right.name) || left.serverId.localeCompare(right.serverId),
  )
  return ranked.map(({ item }) => item)
}

export async function buildNamespaceCatalogSummary(
  registry: DownstreamRegistry,
  namespace: string,
): Promise<{ toolCount: number; totalTokens: number }> {
  const servers = (await registry.listServers()).filter((server) => server.namespaces.includes(namespace))
  const entries = await Promise.all(
    servers.flatMap(async (server) => {
      const records = await registry.getTools(server.id)
      return records
        .filter((record) => record.namespace === namespace)
        .map((record) => buildAdminToolEntry(server, record))
    }),
  )
  const flattened = entries.flat()
  return {
    toolCount: flattened.length,
    totalTokens: flattened.reduce((sum, entry) => sum + entry.totalTokens, 0),
  }
}

export async function findServerForTool(
  registry: DownstreamRegistry,
  namespace: string,
  toolName: string,
): Promise<DownstreamServer | undefined> {
  for (const { server, records } of registry.getToolsByNamespace(namespace)) {
    if (records.some((record) => record.name === toolName)) return server
  }
  return undefined
}

function toVisibleTool(toolcard: Toolcard): VisibleTool {
  return {
    name: toolcard.name,
    description: toolcard.description,
    inputSchema: toolcard.inputSchema,
    serverId: toolcard.serverId,
    namespace: toolcard.namespace,
    riskLevel: toolcard.riskLevel,
    tags: toolcard.tags,
  }
}
