import type { GatewayConfig } from '../config/loader.js'
import type { Mode } from '../types/enums.js'
import type { Toolcard, VisibleTool } from '../types/tools.js'
import type { StarterPacksFile } from '../config/schemas.js'

type StarterPack = StarterPacksFile['starterPacks'][string]

function toVisibleTool(tc: Toolcard): VisibleTool {
  return {
    name: tc.name,
    description: tc.description,
    inputSchema: tc.inputSchema,
    serverId: tc.serverId,
    namespace: tc.namespace,
    riskLevel: tc.riskLevel,
    tags: tc.tags,
  }
}

export function buildBootstrapWindowFallback(
  candidates: Toolcard[],
  bootstrapWindowSize: number,
): VisibleTool[] {
  if (candidates.length === 0) return []

  return candidates
    .filter((tc) => !tc.quarantined)
    .slice(0, bootstrapWindowSize)
    .map(toVisibleTool)
}

export function buildBootstrapWindow(
  candidates: Toolcard[],
  starterPack: StarterPack,
  bootstrapWindowSize: number,
  mode: Mode,
): VisibleTool[] {
  if (candidates.length === 0) return []
  if (!starterPack.includeModes.includes(mode)) return []

  const filtered = candidates.filter(
    (tc) => !tc.quarantined && starterPack.includeRiskLevels.includes(tc.riskLevel),
  )

  const limit = Math.min(bootstrapWindowSize, starterPack.maxTools)
  const selected = filtered.slice(0, limit)

  return selected.map(toVisibleTool)
}

export function buildBootstrapWindowFromConfig(
  candidates: Toolcard[],
  config: GatewayConfig,
  namespace: string,
  mode: Mode,
): VisibleTool[] {
  const starterPack = config.starterPacks[namespace]
  const namespacePolicy = config.namespaces[namespace]
  const bootstrapWindowSize = namespacePolicy?.bootstrapWindowSize ?? candidates.length
  if (!starterPack) return buildBootstrapWindowFallback(candidates, bootstrapWindowSize)

  return buildBootstrapWindow(candidates, starterPack, bootstrapWindowSize, mode)
}
