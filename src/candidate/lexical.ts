import type { Toolcard } from '../types/tools.js'

export type LexicalSignals = {
  hintTags: string[]
  recentToolKeys: string[]
  recentToolNames: string[]
  namespace: string
}

export function toolCandidateKey(serverId: string, toolName: string): string {
  return `${serverId}::${toolName}`
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s_\-./]+/)
    .filter((t) => t.length >= 2)
}

export function scoreLexical(
  tc: Toolcard,
  signals: LexicalSignals,
): { score: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {}

  // +2 per tag in hintTags
  let tagScore = 0
  for (const tag of tc.tags) {
    if (signals.hintTags.includes(tag)) {
      tagScore += 2
    }
  }
  if (tagScore > 0) breakdown.tags = tagScore

  // +1 per name token that matches any hintTag token
  const nameTokens = tokenize(tc.name)
  const hintTokens = new Set(signals.hintTags.flatMap((h) => tokenize(h)))
  let nameTokenScore = 0
  for (const tok of nameTokens) {
    if (hintTokens.has(tok)) {
      nameTokenScore += 1
    }
  }
  if (nameTokenScore > 0) breakdown.nameToken = nameTokenScore

  // +1 if namespace hint matches
  let namespaceScore = 0
  if (tc.namespaceHints && tc.namespaceHints.includes(signals.namespace)) {
    namespaceScore = 1
  }
  if (namespaceScore > 0) breakdown.namespace = namespaceScore

  // +3 if tool name is in recentToolNames (success)
  let recencyScore = 0
  if (signals.recentToolKeys.includes(toolCandidateKey(tc.serverId, tc.name))) {
    recencyScore = 3
  }
  if (recencyScore > 0) breakdown.recency = recencyScore

  // +1 if shares first token with any recent tool (neighbor)
  let neighborScore = 0
  const firstToken = nameTokens[0]
  if (firstToken) {
    for (const recentName of signals.recentToolNames) {
      const recentFirst = tokenize(recentName)[0]
      if (recentFirst && recentFirst === firstToken && recentName !== tc.name) {
        neighborScore = 1
        break
      }
    }
  }
  if (neighborScore > 0) breakdown.neighbor = neighborScore

  const score = tagScore + nameTokenScore + namespaceScore + recencyScore + neighborScore
  return { score, breakdown }
}
