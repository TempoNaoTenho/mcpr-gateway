import { describe, expect, it } from 'vitest'
import { splitCommandLine } from '../../src/lib/command-line.js'

describe('splitCommandLine()', () => {
  it('splits a plain command line into executable and args', () => {
    expect(splitCommandLine('npx -y mcp-remote https://example.com/mcp')).toEqual([
      'npx',
      '-y',
      'mcp-remote',
      'https://example.com/mcp',
    ])
  })

  it('preserves quoted arguments', () => {
    expect(splitCommandLine('node script.js --header "X API Key=secret value"')).toEqual([
      'node',
      'script.js',
      '--header',
      'X API Key=secret value',
    ])
  })
})
