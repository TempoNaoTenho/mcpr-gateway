import { toolCandidateKey } from '../candidate/lexical.js'
import type { Toolcard, VisibleTool } from '../types/tools.js'

export function buildVisibleToolCatalog(
  toolcards: Toolcard[],
  disabledToolKeys: ReadonlySet<string>
): VisibleTool[] {
  return toolcards
    .filter((tc) => !tc.quarantined)
    .filter((tc) => !disabledToolKeys.has(toolCandidateKey(tc.serverId, tc.name)))
    .map((tc) => ({
      name: tc.name,
      description: tc.description,
      inputSchema: tc.inputSchema,
      serverId: tc.serverId,
      namespace: tc.namespace,
      riskLevel: tc.riskLevel,
      tags: tc.tags,
    }))
}
