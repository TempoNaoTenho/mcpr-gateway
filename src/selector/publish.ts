import type { Toolcard, VisibleTool } from '../types/tools.js'
import type { RerankEntry } from './scorer.js'
import { inferCapabilityFromTool, type ToolCapability } from './focus.js'

const STABILITY_THRESHOLD = 1.0

function toolKey(serverId: string, name: string): string {
  return `${serverId}::${name}`
}

function toolcardToVisible(tc: Toolcard): VisibleTool {
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

export type PublishExclusion = { toolName: string; reason: string }

type PublishOptions = {
  dominantCapability?: ToolCapability
  reserveSlots?: number
}

function applyFocusReserve(
  selected: VisibleTool[],
  ranked: RerankEntry[],
  reserveSlots: number,
  dominantCapability?: ToolCapability,
): VisibleTool[] {
  if (!dominantCapability || reserveSlots <= 0 || selected.length <= reserveSlots) {
    return selected
  }

  const selectedKeys = new Set(selected.map((tool) => toolKey(tool.serverId, tool.name)))
  const selectedOutsideFocus = selected.filter(
    (tool) => inferCapabilityFromTool(tool) !== dominantCapability,
  )

  if (selectedOutsideFocus.length >= reserveSlots) {
    return selected
  }

  const replacementsNeeded = reserveSlots - selectedOutsideFocus.length
  const fallbackCandidates = ranked
    .map((entry) => toolcardToVisible(entry.toolcard))
    .filter((tool) => (
      !selectedKeys.has(toolKey(tool.serverId, tool.name)) &&
      inferCapabilityFromTool(tool) !== dominantCapability
    ))
    .slice(0, replacementsNeeded)

  if (fallbackCandidates.length === 0) {
    return selected
  }

  const nextSelected = [...selected]
  for (const candidate of fallbackCandidates) {
    const replaceIndex = [...nextSelected]
      .map((tool, index) => ({ tool, index }))
      .reverse()
      .find(({ tool }) => inferCapabilityFromTool(tool) === dominantCapability)?.index

    if (replaceIndex === undefined) break
    nextSelected.splice(replaceIndex, 1, candidate)
  }

  return nextSelected
}

export function publishWindow(
  ranked: RerankEntry[],
  activeWindowSize: number,
  currentWindow: VisibleTool[],
  options: PublishOptions = {},
): { selected: VisibleTool[]; reasoning: string; exclusions: PublishExclusion[] } {
  const currentByKey = new Map(currentWindow.map((t) => [toolKey(t.serverId, t.name), t]))
  const rankedByKey = new Map(ranked.map((e) => [toolKey(e.toolcard.serverId, e.toolcard.name), e]))

  const topN = ranked.slice(0, activeWindowSize)
  const topNKeys = new Set(topN.map((e) => toolKey(e.toolcard.serverId, e.toolcard.name)))

  // Current window tools that were displaced from top-N but are still ranked
  const displacedCurrent = currentWindow
    .filter((t) => {
      const key = toolKey(t.serverId, t.name)
      return !topNKeys.has(key) && rankedByKey.has(key)
    })
    .map((t) => ({ tool: t, entry: rankedByKey.get(toolKey(t.serverId, t.name))! }))

  const selected: VisibleTool[] = []
  const usedKeys = new Set<string>()
  const replacedByStability: string[] = []
  let kept = 0
  let replaced = 0

  for (const candidate of topN) {
    const candidateKey = toolKey(candidate.toolcard.serverId, candidate.toolcard.name)

    if (currentByKey.has(candidateKey)) {
      // Already in current window — keep it
      selected.push(toolcardToVisible(candidate.toolcard))
      usedKeys.add(candidateKey)
      kept++
      continue
    }

    // Find a displaced current window tool within stability threshold
    const stableReplacement = displacedCurrent.find(
      (d) =>
        !usedKeys.has(toolKey(d.tool.serverId, d.tool.name)) &&
        candidate.score - d.entry.score < STABILITY_THRESHOLD,
    )

    if (stableReplacement) {
      const stableKey = toolKey(stableReplacement.tool.serverId, stableReplacement.tool.name)
      selected.push(stableReplacement.tool)
      usedKeys.add(stableKey)
      replacedByStability.push(candidate.toolcard.name)
      kept++
    } else {
      selected.push(toolcardToVisible(candidate.toolcard))
      usedKeys.add(candidateKey)
      replaced++
    }
  }

  // Build exclusion reasons for all ranked tools not selected
  const finalSelected = applyFocusReserve(
    selected,
    ranked,
    options.reserveSlots ?? 0,
    options.dominantCapability,
  )

  const selectedKeys = new Set(finalSelected.map((t) => toolKey(t.serverId, t.name)))
  const exclusions: PublishExclusion[] = ranked
    .map((e, rank) => ({ e, rank }))
    .filter(({ e }) => !selectedKeys.has(toolKey(e.toolcard.serverId, e.toolcard.name)))
    .map(({ e, rank }) => {
      const name = e.toolcard.name
      if (replacedByStability.includes(name)) {
        return { toolName: name, reason: 'replaced by stable current window tool' }
      }
      return { toolName: name, reason: `below window size (rank ${rank + 1})` }
    })

  const reasoning = `Selected ${finalSelected.length} tools: ${kept} retained from previous window, ${replaced} new additions.`
  return { selected: finalSelected, reasoning, exclusions }
}
