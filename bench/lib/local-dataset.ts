import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GatewayConfig } from '../../src/config/index.js'
import type { DownstreamRegistry } from '../../src/registry/registry.js'
import type { ToolRecord } from '../../src/types/tools.js'
import { Mode } from '../../src/types/enums.js'
import type { BenchmarkDataset, BenchmarkScenario } from '../types.js'

export type DatasetPreparationDiagnostics = {
  config: {
    source: string
    configPath: string
    databasePath?: string
    activeVersion?: number
  }
  namespaces: Array<{
    name: string
    serverCount: number
    toolCount: number
  }>
  servers: Array<{
    serverId: string
    transport: string
    namespaces: string[]
    enabled: boolean
    toolCount: number
    healthStatus?: string
    healthError?: string
  }>
  mcpChecks: Array<{
    namespace: string
    sessionCreated: boolean
    visibleToolCount: number
    visibleToolNames: string[]
    error?: string
  }>
  generation: {
    scenarioCount: number
    skippedServerCount: number
    skippedServers: string[]
  }
}

type ToolWithNamespace = ToolRecord & { namespace: string }

const PREFERRED_NAME_PATTERNS = [
  /\bsearch\b/i,
  /\bfind\b/i,
  /\blist\b/i,
  /\bquery\b/i,
  /\bread\b/i,
  /\bget\b/i,
  /\bopen\b/i,
  /\brender\b/i,
]

export function generateDatasetFromRegistry(
  config: GatewayConfig,
  registry: DownstreamRegistry,
  options?: {
    authHeader?: string
    datasetName?: string
    maxScenariosPerServer?: number
  },
): { dataset: BenchmarkDataset; diagnostics: Omit<DatasetPreparationDiagnostics, 'config' | 'mcpChecks'> } {
  const scenarios: BenchmarkScenario[] = []
  const namespaceSummaries: DatasetPreparationDiagnostics['namespaces'] = []
  const serverDiagnostics: DatasetPreparationDiagnostics['servers'] = []
  const skippedServers = new Set<string>()
  const maxPerServer = options?.maxScenariosPerServer ?? 2

  for (const namespace of Object.keys(config.namespaces).sort()) {
    const groups = registry.getToolsByNamespace(namespace)
    namespaceSummaries.push({
      name: namespace,
      serverCount: groups.length,
      toolCount: groups.reduce((sum, group) => sum + group.records.length, 0),
    })

    for (const group of groups) {
      const healthState = registry.getHealthState(group.server.id)
      serverDiagnostics.push({
        serverId: group.server.id,
        transport: group.server.transport,
        namespaces: group.server.namespaces,
        enabled: group.server.enabled,
        toolCount: group.records.length,
        healthStatus: healthState?.status,
        healthError: healthState?.error,
      })

      if (group.records.length === 0) {
        skippedServers.add(group.server.id)
        continue
      }

      const selected = selectScenarioTools(group.records, maxPerServer)
      for (const tool of selected) {
        const scenario = buildScenario(namespace, group.server.id, tool, options?.authHeader)
        if (scenario) scenarios.push(scenario)
      }
    }
  }

  const dataset: BenchmarkDataset = {
    name: options?.datasetName ?? `local-auto-${new Date().toISOString().slice(0, 10)}`,
    description: 'Auto-generated benchmark dataset derived from the effective gateway runtime.',
    scenarios,
  }

  return {
    dataset,
    diagnostics: {
      namespaces: namespaceSummaries,
      servers: dedupeServerDiagnostics(serverDiagnostics),
      generation: {
        scenarioCount: scenarios.length,
        skippedServerCount: skippedServers.size,
        skippedServers: [...skippedServers].sort(),
      },
    },
  }
}

export function writePreparedArtifacts(
  outputDirArg: string,
  dataset: BenchmarkDataset,
  diagnostics: DatasetPreparationDiagnostics,
): {
  outputDir: string
  datasetPath?: string
  diagnosticsPath: string
} {
  const outputDir = resolve(outputDirArg)
  mkdirSync(outputDir, { recursive: true })
  const diagnosticsPath = resolve(outputDir, `${dataset.name}.diagnostics.json`)
  writeFileSync(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`)

  if (dataset.scenarios.length === 0) {
    return { outputDir, diagnosticsPath }
  }

  const datasetPath = resolve(outputDir, `${dataset.name}.json`)
  writeFileSync(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`)
  return { outputDir, datasetPath, diagnosticsPath }
}

function selectScenarioTools(records: ToolRecord[], maxPerServer: number): ToolWithNamespace[] {
  const ranked = [...records]
    .map((tool) => ({ tool, score: toolSelectionScore(tool) }))
    .sort((left, right) => (
      right.score - left.score ||
      left.tool.name.localeCompare(right.tool.name)
    ))
    .map(({ tool }) => tool)

  return ranked.slice(0, maxPerServer)
}

function toolSelectionScore(tool: ToolRecord): number {
  let score = 0
  for (const pattern of PREFERRED_NAME_PATTERNS) {
    if (pattern.test(tool.name)) score += 10
    if (tool.description && pattern.test(tool.description)) score += 4
  }

  const requiredCount = getRequiredKeys(tool.inputSchema).length
  score -= requiredCount * 2
  if (requiredCount === 0) score += 3
  if (tool.description) score += Math.min(tool.description.length, 120) / 120
  return score
}

function buildScenario(
  namespace: string,
  serverId: string,
  tool: ToolRecord,
  authHeader?: string,
): BenchmarkScenario | null {
  const toolArgs = inferToolArgs(tool.inputSchema, tool)
  const requiredKeys = getRequiredKeys(tool.inputSchema)
  if (requiredKeys.length > 0 && !toolArgs) {
    return null
  }

  const prompt = buildPrompt(tool)
  const discoveryQuery = buildDiscoveryQuery(serverId, tool)
  return {
    id: sanitizeId(`${namespace}-${serverId}-${tool.name}`),
    namespace,
    prompt,
    expectedTools: [tool.name],
    expectedServerIds: [serverId],
    discoveryQuery,
    mode: Mode.Read,
    ...(toolArgs ? { toolArgs } : {}),
    ...(authHeader ? { authHeader } : {}),
  }
}

function buildPrompt(tool: ToolRecord): string {
  const action = humanizeToolName(tool.name)
  if (tool.description) {
    const summary = tool.description.replace(/\s+/g, ' ').trim().replace(/[.]+$/, '')
    return `${capitalize(action)}. ${summary}`
  }
  return `${capitalize(action)} using the MCP tool ${tool.name}.`
}

function buildDiscoveryQuery(serverId: string, tool: ToolRecord): string {
  const descriptionTokens = (tool.description ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .slice(0, 6)
  return [serverId, ...tool.name.split(/[_\-.]/), ...descriptionTokens]
    .filter(Boolean)
    .join(' ')
    .trim()
}

function inferToolArgs(
  inputSchema: Record<string, unknown>,
  tool: ToolRecord,
): Record<string, unknown> | undefined {
  const requiredKeys = getRequiredKeys(inputSchema)
  if (requiredKeys.length === 0) return undefined

  const properties = (
    typeof inputSchema['properties'] === 'object' &&
    inputSchema['properties'] !== null &&
    !Array.isArray(inputSchema['properties'])
  ) ? inputSchema['properties'] as Record<string, unknown> : {}

  const args: Record<string, unknown> = {}
  for (const key of requiredKeys) {
    const schema = (
      typeof properties[key] === 'object' &&
      properties[key] !== null &&
      !Array.isArray(properties[key])
    ) ? properties[key] as Record<string, unknown> : {}
    const value = inferValueForKey(key, schema, tool)
    if (value === undefined) return undefined
    args[key] = value
  }

  return args
}

function inferValueForKey(
  key: string,
  schema: Record<string, unknown>,
  tool: ToolRecord,
): unknown {
  const lowerKey = key.toLowerCase()
  const type = typeof schema['type'] === 'string' ? schema['type'] : undefined

  if (type === 'integer' || type === 'number') return 1
  if (type === 'boolean') return false
  if (type === 'array') return []

  if (type && type !== 'string') return undefined

  if (/\b(query|q|search|term|text|keyword)\b/.test(lowerKey)) {
    return tool.description ? tool.description.split(/\s+/).slice(0, 6).join(' ') : tool.name
  }
  if (/\b(repo|repository)\b/.test(lowerKey)) return 'mcpr-gateway'
  if (/\b(namespace)\b/.test(lowerKey)) return tool.namespace
  if (/\b(path|file)\b/.test(lowerKey)) return '.'
  if (/\b(url|uri)\b/.test(lowerKey)) return 'https://example.com'
  if (/\b(id|name|key|slug)\b/.test(lowerKey)) return tool.name
  if (/\b(prompt)\b/.test(lowerKey)) return buildPrompt(tool)

  return undefined
}

function getRequiredKeys(inputSchema: Record<string, unknown>): string[] {
  if (!Array.isArray(inputSchema['required'])) return []
  return inputSchema['required'].filter((value): value is string => typeof value === 'string')
}

function humanizeToolName(name: string): string {
  return name
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function dedupeServerDiagnostics(
  input: DatasetPreparationDiagnostics['servers'],
): DatasetPreparationDiagnostics['servers'] {
  const seen = new Set<string>()
  const result: DatasetPreparationDiagnostics['servers'] = []
  for (const item of input) {
    if (seen.has(item.serverId)) continue
    seen.add(item.serverId)
    result.push(item)
  }
  return result.sort((left, right) => left.serverId.localeCompare(right.serverId))
}
