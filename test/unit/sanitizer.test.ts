import { describe, expect, it } from 'vitest'
import { sanitizeDescription } from '../../src/toolcard/sanitizer.js'
import { generateToolcard } from '../../src/toolcard/generator.js'
import { SourceTrustLevel } from '../../src/types/enums.js'
import type { DownstreamServer } from '../../src/types/server.js'
import type { ToolRecord } from '../../src/types/tools.js'

const server: DownstreamServer = {
  id: 'server-1',
  transport: 'stdio',
  command: 'echo',
  args: [],
  env: {},
  namespaces: ['default'],
  trustLevel: SourceTrustLevel.Verified,
}

describe('sanitizeDescription', () => {
  it('preserves blank-line paragraph breaks', () => {
    const a = 'First paragraph ends here.'
    const b = 'Second paragraph starts here.'
    expect(sanitizeDescription(`${a}\n\n${b}`)).toBe(`${a}\n\n${b}`)
  })

  it('normalizes CRLF and collapses runs of blank lines to at most one', () => {
    expect(sanitizeDescription(`Line1\r\n\r\nLine2`)).toBe('Line1\n\nLine2')
    expect(sanitizeDescription('A\n\n\n\nB')).toBe('A\n\nB')
  })

  it('collapses multiple spaces within a line only', () => {
    expect(sanitizeDescription('Too   many     spaces')).toBe('Too many spaces')
  })
})

describe('generateToolcard + newlines', () => {
  it('keeps paragraph breaks in tool description', () => {
    const desc = "Resolves a package.\n\nYou MUST call this next."
    const record: ToolRecord = {
      name: 'x',
      description: desc,
      inputSchema: { type: 'object' },
      serverId: 'server-1',
      namespace: 'default',
      retrievedAt: new Date().toISOString(),
      sanitized: false,
    }
    const toolcard = generateToolcard(record, server)
    expect(toolcard.description).toBe(desc)
  })
})
