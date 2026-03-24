import { describe, expect, it } from 'vitest'
import { generateToolcard } from '../../src/toolcard/generator.js'
import { SourceTrustLevel, ToolRiskLevel } from '../../src/types/enums.js'
import type { DownstreamServer } from '../../src/types/server.js'
import type { ToolRecord } from '../../src/types/tools.js'

const server: DownstreamServer = {
  id: 'server-1',
  transport: 'stdio',
  command: 'echo',
  args: [],
  env: {},
  namespaces: ['gmail'],
  trustLevel: SourceTrustLevel.Verified,
}

function makeRecord(inputSchema: ToolRecord['inputSchema']): ToolRecord {
  return {
    name: 'gmail.read_message',
    description: 'Read a message',
    inputSchema,
    serverId: 'server-1',
    namespace: 'gmail',
    retrievedAt: new Date().toISOString(),
    sanitized: false,
  }
}

describe('generateToolcard', () => {
  it('does not quarantine an object schema without top-level properties', () => {
    const toolcard = generateToolcard(makeRecord({ type: 'object' }), server)
    expect(toolcard.quarantined).toBe(false)
    expect(toolcard.riskLevel).toBe(ToolRiskLevel.Low)
  })

  it('does not quarantine a composed schema without top-level properties', () => {
    const toolcard = generateToolcard(
      makeRecord({
        type: 'object',
        allOf: [{ properties: { query: { type: 'string' } } }],
      }),
      server,
    )
    expect(toolcard.quarantined).toBe(false)
  })

  it('still quarantines malformed non-object schemas', () => {
    const toolcard = generateToolcard(makeRecord([]), server)
    expect(toolcard.quarantined).toBe(true)
    expect(toolcard.quarantineReason).toBe('inputSchema must be a JSON object')
    expect(toolcard.riskLevel).toBe(ToolRiskLevel.High)
  })

  it('does not quarantine legitimate tool usage instructions in descriptions', () => {
    const toolcard = generateToolcard({
      ...makeRecord({ type: 'object' }),
      description: 'You MUST call this function before querying docs to obtain a valid library ID.',
    }, server)

    expect(toolcard.quarantined).toBe(false)
  })

  it('truncates long descriptions instead of quarantining the tool', () => {
    const toolcard = generateToolcard({
      ...makeRecord({ type: 'object' }),
      description: 'A'.repeat(1001),
    }, server)

    expect(toolcard.quarantined).toBe(false)
    expect(toolcard.description).toHaveLength(512)
  })
})
