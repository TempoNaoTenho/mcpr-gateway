import { describe, expect, it } from 'vitest'
import { GATEWAY_SERVER_ID } from '../../src/gateway/gateway-constants.js'
import { compressDescription, compressSchema } from '../../src/gateway/publish/compress.js'
import { projectToPublic } from '../../src/gateway/publish/project.js'
import { ToolRiskLevel } from '../../src/types/enums.js'
import type { VisibleTool } from '../../src/types/tools.js'

const selectorConfig = {
  lexical: { enabled: true },
  penalties: { write: 0.2, admin: 0.5, unhealthyDownstream: 0.7 },
  focus: { enabled: true, lookback: 5, minDominantSuccesses: 2, reserveSlots: 1, crossDomainPenalty: 1 },
  publication: {
    descriptionCompression: 'conservative' as const,
    schemaCompression: 'conservative' as const,
    descriptionMaxLength: 160,
  },
}

function makeVisibleTool(): VisibleTool {
  return {
    name: 'search_docs',
    description: 'Search the documentation for API details. For example, use this tool before asking the model to guess parameter names.',
    inputSchema: {
      type: 'object',
      title: 'DocsSearch',
      properties: {
        query: {
          type: 'string',
          description: 'Search query text. For example, "auth token refresh".',
          examples: ['auth token refresh'],
        },
        filters: {
          type: 'object',
          properties: {
            language: {
              type: 'string',
              description: 'Deep nested description that should disappear at publish time.',
            },
          },
        },
      },
      required: ['query'],
      examples: [{ query: 'auth token refresh' }],
    },
    serverId: 'docs',
    namespace: 'default',
    riskLevel: ToolRiskLevel.Low,
    tags: ['docs'],
  }
}

describe('publish compression', () => {
  it('compresses descriptions to a single concise sentence', () => {
    expect(
      compressDescription(
        'Search the documentation for API details. For example, use this tool before guessing.',
        selectorConfig.publication,
      ),
    ).toBe('Search the documentation for API details.')
  })

  it('does not apply a character clamp when descriptionMaxLength is 0', () => {
    const longFirstSentence =
      'Resolve a user-provided package/product name to a Context7-compatible library ID and optionally load library documentation with additional parameters like topic or tokens; return structured fields for clients.'
    const input = `${longFirstSentence} Second sentence should be dropped by conservative cleanup.`
    const out = compressDescription(input, {
      ...selectorConfig.publication,
      descriptionMaxLength: 0,
    })
    expect(out).toBe(longFirstSentence)
  })

  it('leaves descriptions unchanged when compression config is not conservative', () => {
    const raw = 'Hello world. Second sentence.'
    expect(compressDescription(raw, {})).toBe(raw)
    expect(compressDescription(raw, { descriptionCompression: 'off' })).toBe(raw)
  })

  it('removes doc-only schema fields while preserving validation keys', () => {
    const compressed = compressSchema(makeVisibleTool().inputSchema, selectorConfig.publication)

    expect(compressed['title']).toBeUndefined()
    expect(compressed['examples']).toBeUndefined()
    expect((compressed.properties as Record<string, unknown>).query).toMatchObject({
      type: 'string',
      description: 'Search query text.',
    })
    expect((((compressed.properties as Record<string, unknown>).filters as Record<string, unknown>).properties as Record<string, unknown>).language).toMatchObject({
      type: 'string',
    })
    expect(((((compressed.properties as Record<string, unknown>).filters as Record<string, unknown>).properties as Record<string, unknown>).language as Record<string, unknown>).description).toBeUndefined()
    expect(compressed.required).toEqual(['query'])
  })

  it('projects a published tool using compressed description and schema', () => {
    const projected = projectToPublic(makeVisibleTool(), selectorConfig)
    expect(projected.description).toBe('Search the documentation for API details.')
    expect(projected.inputSchema).toMatchObject({
      type: 'object',
      required: ['query'],
    })
  })

  it('never compresses built-in gateway meta-tools regardless of publication settings', () => {
    const longDescription =
      'Search for tools across all connected servers in this namespace. Returns matching tool names and server IDs. Use gateway_call_tool with the exact returned name+serverId to execute a match. Do not guess aliases or historical tool names. Tips: try short queries first.'
    const gatewayTool: VisibleTool = {
      name: 'gateway_search_tools',
      description: longDescription,
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
      namespace: 'default',
      riskLevel: ToolRiskLevel.Low,
      tags: ['search', 'discovery'],
    }

    const projected = projectToPublic(gatewayTool, selectorConfig)
    expect(projected.description).toBe(longDescription)
    expect(projected.inputSchema).toEqual(gatewayTool.inputSchema)
  })
})
