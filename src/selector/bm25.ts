import type { Toolcard } from '../types/tools.js'
import { tokenize } from '../candidate/lexical.js'

const BM25_K1 = 1.2
const BM25_B = 0.75
const DEFAULT_EMPTY_SCORE = 0

export type RankedTool = {
  toolcard: Toolcard
  score: number
  matchedTerms: string[]
}

type RankedDocument<T> = {
  item: T
  score: number
  matchedTerms: string[]
}

type IndexedDocument<T> = {
  item: T
  tokens: string[]
  termCounts: Map<string, number>
  length: number
}

function buildIndex<T>(
  items: T[],
  getText: (item: T) => string | undefined,
): IndexedDocument<T>[] {
  return items.map((item) => {
    const text = getText(item)
    const tokens = typeof text === 'string' ? tokenize(text) : []
    const termCounts = new Map<string, number>()
    for (const token of tokens) {
      termCounts.set(token, (termCounts.get(token) ?? 0) + 1)
    }
    return { item, tokens, termCounts, length: tokens.length }
  })
}

function stableSortRankedDocuments<T>(
  entries: RankedDocument<T>[],
  tieBreaker: (left: T, right: T) => number,
): RankedDocument<T>[] {
  return entries.sort((left, right) => {
    const diff = right.score - left.score
    if (diff !== 0) return diff
    return tieBreaker(left.item, right.item)
  })
}

export function rankByBm25<T>(
  items: T[],
  query: string,
  getText: (item: T) => string | undefined,
  tieBreaker: (left: T, right: T) => number,
): RankedDocument<T>[] {
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0) {
    return stableSortRankedDocuments(
      items.map((item) => ({ item, score: DEFAULT_EMPTY_SCORE, matchedTerms: [] })),
      tieBreaker,
    )
  }

  const documents = buildIndex(items, getText)
  const avgDocLength = documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(documents.length, 1)
  const documentFrequency = new Map<string, number>()

  for (const term of queryTerms) {
    let count = 0
    for (const doc of documents) {
      if (doc.termCounts.has(term)) {
        count += 1
      }
    }
    documentFrequency.set(term, count)
  }

  return stableSortRankedDocuments(
    documents.map(({ item, termCounts, length }) => {
      let score = 0
      const matchedTerms: string[] = []

      for (const term of queryTerms) {
        const tf = termCounts.get(term) ?? 0
        if (tf === 0) continue

        matchedTerms.push(term)
        const df = documentFrequency.get(term) ?? 0
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
        const normalizedLength = avgDocLength > 0 ? length / avgDocLength : 1
        const numerator = tf * (BM25_K1 + 1)
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * normalizedLength)
        score += idf * (numerator / denominator)
      }

      return { item, score, matchedTerms }
    }),
    tieBreaker,
  )
}

function toolTieBreaker(left: Toolcard, right: Toolcard): number {
  const nameDiff = left.name.localeCompare(right.name)
  if (nameDiff !== 0) return nameDiff
  return left.serverId.localeCompare(right.serverId)
}

function buildCombinedToolText(toolcard: Toolcard): string {
  return [
    toolcard.name,
    toolcard.tags.join(' '),
    toolcard.serverId,
    toolcard.description ?? '',
  ]
    .filter(Boolean)
    .join(' ')
}

export function rankToolsWithBm25(
  tools: Toolcard[],
  query: string,
): RankedTool[] {
  return rankByBm25(
    tools,
    query,
    buildCombinedToolText,
    toolTieBreaker,
  ).map((entry) => ({
    toolcard: entry.item,
    score: entry.score,
    matchedTerms: entry.matchedTerms,
  }))
}
