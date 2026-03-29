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
  serverId?: string
  risk?: string
  tags?: string[]
  requiredArgs?: string[]
  limit?: number
  detail?: CatalogDetailLevel
}

type CatalogSearchOptions = {
  k?: number
  limit?: number
  serverId?: string
  risk?: string
  tags?: string[]
  requiredArgs?: string[]
  detail?: CatalogDetailLevel
}

type CatalogDescribeOptions = {
  detail?: CatalogDetailLevel
  fields?: string[]
}

type SignatureProperty = {
  type?: string | string[]
  description?: string
  enum?: unknown[]
}

type SignatureShape = {
  required: string[]
  properties: Record<string, SignatureProperty>
  acceptsAdditionalProperties?: boolean
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

function buildSignatureShape(tool: Toolcard): SignatureShape {
  const schema = tool.inputSchema
  const rawProperties =
    schema && typeof schema === 'object' && !Array.isArray(schema) && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {}

  const properties = Object.fromEntries(
    Object.entries(rawProperties).map(([name, value]) => {
      const property: SignatureProperty = {}
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const type = (value as Record<string, unknown>).type
        const description = (value as Record<string, unknown>).description
        const enumValues = (value as Record<string, unknown>).enum

        if (typeof type === 'string') {
          property.type = type
        } else if (Array.isArray(type) && type.every((entry) => typeof entry === 'string')) {
          property.type = type as string[]
        }

        if (typeof description === 'string' && description.trim().length > 0) {
          property.description = description.trim()
        }

        if (Array.isArray(enumValues) && enumValues.length > 0) {
          property.enum = enumValues
        }
      }
      return [name, property]
    })
  )

  const acceptsAdditionalProperties =
    schema && typeof schema === 'object' && !Array.isArray(schema) && typeof schema.additionalProperties === 'boolean'
      ? schema.additionalProperties
      : undefined

  return {
    required: signatureFields(tool),
    properties,
    acceptsAdditionalProperties,
  }
}

function matchesFilters(
  tool: Toolcard,
  filters: {
    serverId?: string
    risk?: string
    tags?: string[]
    requiredArgs?: string[]
  }
): boolean {
  if (filters.serverId && tool.serverId !== filters.serverId) {
    return false
  }
  if (filters.risk && tool.riskLevel !== filters.risk) {
    return false
  }
  if (filters.tags && filters.tags.length > 0) {
    if (!filters.tags.every((tag) => tool.tags.includes(tag))) {
      return false
    }
  }
  if (filters.requiredArgs && filters.requiredArgs.length > 0) {
    const required = new Set(signatureFields(tool))
    if (!filters.requiredArgs.every((field) => required.has(field))) {
      return false
    }
  }
  return true
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
    const requestedCount =
      typeof options.k === 'number'
        ? options.k
        : typeof options.limit === 'number'
          ? options.limit
          : 5
    const searchable = this.toolcards.filter((tool) =>
      matchesFilters(tool, {
        serverId: options.serverId,
        risk: options.risk,
        tags: options.tags,
        requiredArgs: options.requiredArgs,
      })
    )
    const ranked = rankToolsWithBm25(searchable, query)
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        const diff = right.score - left.score
        if (diff !== 0) return diff
        return left.toolcard.name.localeCompare(right.toolcard.name)
      })
      .slice(0, Math.max(1, Math.min(25, requestedCount)))

    return ranked.map(({ toolcard }) => this.formatTool(toolcard, detail))
  }

  servers(): unknown[] {
    const serverIds = [...new Set(this.toolcards.map((tool) => tool.serverId))]
      .filter((serverId) => typeof serverId === 'string' && serverId.length > 0)
      .sort((left, right) => left.localeCompare(right))
    return serverIds.map((serverId) => ({ serverId }))
  }

  list(filters: CatalogListFilters = {}): unknown[] {
    const detail = filters.detail ?? 'summary'
    const visible = this.toolcards.filter((tool) =>
      matchesFilters(tool, {
        serverId: filters.serverId,
        risk: filters.risk,
        tags: filters.tags,
        requiredArgs: filters.requiredArgs,
      })
    )
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
      const signature = buildSignatureShape(tool)
      return {
        handle,
        name: tool.name,
        summary: summarizeDescription(tool),
        risk: tool.riskLevel,
        args: signature.required,
        required: signature.required,
        properties: signature.properties,
        acceptsAdditionalProperties: signature.acceptsAdditionalProperties,
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
