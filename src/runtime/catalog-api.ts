import { getConfig } from '../config/index.js'
import { disabledToolKeysForNamespace } from '../config/disabled-tool-keys.js'
import { toolCandidateKey } from '../candidate/lexical.js'
import { rankToolsWithBm25 } from '../selector/bm25.js'
import { generateToolcards } from '../toolcard/index.js'
import type { SessionState } from '../types/session.js'
import type { Toolcard } from '../types/tools.js'
import type { IRegistryAdapter } from '../types/interfaces.js'
import type { HandleRegistry } from './handle-registry.js'

export type CatalogDetailLevel = 'name' | 'summary' | 'signature' | 'full'

type CatalogListFilters = {
  risk?: string
  tags?: string[]
  limit?: number
  detail?: CatalogDetailLevel
}

type CatalogSearchOptions = {
  k?: number
  detail?: CatalogDetailLevel
}

type CatalogDescribeOptions = {
  detail?: CatalogDetailLevel
  fields?: string[]
}

function summarizeDescription(tool: Toolcard): string {
  if (tool.summary && tool.summary.trim().length > 0) {
    return tool.summary.trim()
  }
  const description = tool.description?.trim() ?? ''
  if (description.length === 0) return tool.name
  const firstSentence = description.split(/[.!?]\s/, 1)[0]
  return firstSentence && firstSentence.length > 0 ? firstSentence : description
}

function signatureFields(tool: Toolcard): string[] {
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []
  return required.filter((field): field is string => typeof field === 'string')
}

export class CatalogRuntimeApi {
  private readonly toolcards: Toolcard[]

  constructor(
    private readonly session: SessionState,
    private readonly registry: IRegistryAdapter,
    private readonly handles: HandleRegistry,
  ) {
    this.toolcards = this.loadToolcards()
  }

  search(query: string, options: CatalogSearchOptions = {}): unknown[] {
    const detail = options.detail ?? 'summary'
    const ranked = rankToolsWithBm25(this.toolcards, query)
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        const diff = right.score - left.score
        if (diff !== 0) return diff
        return left.toolcard.name.localeCompare(right.toolcard.name)
      })
      .slice(0, Math.max(1, Math.min(25, options.k ?? 5)))

    return ranked.map(({ toolcard }) => this.formatTool(toolcard, detail))
  }

  list(filters: CatalogListFilters = {}): unknown[] {
    const detail = filters.detail ?? 'summary'
    let visible = [...this.toolcards]
    if (filters.risk) {
      visible = visible.filter((tool) => tool.riskLevel === filters.risk)
    }
    if (filters.tags && filters.tags.length > 0) {
      visible = visible.filter((tool) => filters.tags!.every((tag) => tool.tags.includes(tag)))
    }
    const limit = Math.max(1, Math.min(100, filters.limit ?? visible.length))
    return visible.slice(0, limit).map((tool) => this.formatTool(tool, detail))
  }

  describe(handle: string, options: CatalogDescribeOptions = {}): unknown {
    const detail = options.detail ?? (options.fields?.includes('schema') ? 'full' : 'signature')
    const target = this.handles.resolve(handle)
    if (!target) {
      throw new Error(`Unknown tool handle: ${handle}`)
    }
    const tool = this.toolcards.find(
      (entry) => entry.serverId === target.serverId && entry.name === target.name,
    )
    if (!tool) {
      throw new Error(`Tool not found for handle: ${handle}`)
    }

    const base = this.formatTool(tool, detail) as Record<string, unknown>
    if (options.fields?.includes('args') && !('args' in base)) {
      base.args = signatureFields(tool)
    }
    return base
  }

  private loadToolcards(): Toolcard[] {
    const config = getConfig()
    const disabledKeys = disabledToolKeysForNamespace(config, this.session.namespace)
    const serverGroups = this.registry.getToolsByNamespace?.(this.session.namespace) ?? []

    return serverGroups
      .flatMap(({ server, records }) => generateToolcards(records, server, server.toolOverrides))
      .filter((toolcard) => !toolcard.quarantined)
      .filter((toolcard) => !disabledKeys.has(toolCandidateKey(toolcard.serverId, toolcard.name)))
  }

  private formatTool(tool: Toolcard, detail: CatalogDetailLevel): Record<string, unknown> {
    const handle = this.handles.register({
      serverId: tool.serverId,
      name: tool.name,
      namespace: tool.namespace,
    })

    if (detail === 'name') {
      return {
        handle,
        name: tool.name,
      }
    }

    if (detail === 'summary') {
      return {
        handle,
        name: tool.name,
        summary: summarizeDescription(tool),
        risk: tool.riskLevel,
      }
    }

    if (detail === 'signature') {
      return {
        handle,
        name: tool.name,
        summary: summarizeDescription(tool),
        risk: tool.riskLevel,
        args: signatureFields(tool),
      }
    }

    return {
      handle,
      name: tool.name,
      summary: summarizeDescription(tool),
      description: tool.description,
      risk: tool.riskLevel,
      args: signatureFields(tool),
      inputSchema: tool.inputSchema,
    }
  }
}
