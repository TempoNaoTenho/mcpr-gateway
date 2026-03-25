import { describe, expect, it } from 'vitest'
import {
  coerceMcpImport,
  extractBalancedJsonObject,
  extractFirstJsonObject,
  formatMcpImportForEditor,
  parseMcpImportText,
} from '../../src/lib/mcp-import-parse.js'

describe('mcp-import-parse', () => {
  it('extracts balanced object from surrounding junk', () => {
    const inner = '{"mcpServers":{"a":{"url":"https://x"}}}'
    const wrapped = `prefix ${inner} suffix`
    expect(extractFirstJsonObject(wrapped)).toBe(inner)
  })

  it('parses full mcpServers with trailing commas', () => {
    const raw = `
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "headers": { "CONTEXT7_API_KEY": "k" },
    },
  },
}
`
    const r = parseMcpImportText(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.mcpServers['context7']).toMatchObject({
      url: 'https://mcp.context7.com/mcp',
      headers: { CONTEXT7_API_KEY: 'k' },
    })
  })

  it('accepts fragment without outer braces (mcpServers only)', () => {
    const raw = `
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
    },
  },
`
    const r = parseMcpImportText(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.mcpServers['context7']).toMatchObject({ url: 'https://mcp.context7.com/mcp' })
  })

  it('accepts flat server map without mcpServers key', () => {
    const raw = `{
      "context7": {
        "url": "https://mcp.context7.com/mcp",
        "headers": { "CONTEXT7_API_KEY": "api_key" }
      }
    }`
    const r = parseMcpImportText(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Object.keys(r.mcpServers)).toEqual(['context7'])
  })

  it('strips markdown fences', () => {
    const raw = '```json\n{"mcpServers":{"x":{"url":"https://u"}}}\n```'
    const r = parseMcpImportText(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.mcpServers['x']).toMatchObject({ url: 'https://u' })
  })

  it('coerceMcpImport accepts object with inferred map', () => {
    const r = coerceMcpImport({
      foo: { url: 'https://example/mcp' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.mcpServers['foo']).toMatchObject({ url: 'https://example/mcp' })
  })

  it('reads defaultNamespace from object', () => {
    const r = coerceMcpImport({
      defaultNamespace: 'ops',
      mcpServers: { a: { url: 'https://u' } },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.defaultNamespace).toBe('ops')
  })

  it('formatMcpImportForEditor pretty-prints mcpServers', () => {
    const s = formatMcpImportForEditor({ x: { url: 'https://u' } })
    expect(s).toContain('\n')
    expect(s).toContain('"mcpServers"')
    expect(s).toContain('"x"')
  })

  it('strips UTF-8 BOM before parsing', () => {
    const raw = `\uFEFF{"mcpServers":{"x":{"url":"https://u"}}}`
    const r = parseMcpImportText(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.mcpServers['x']).toMatchObject({ url: 'https://u' })
  })

  it('parses mcpServers when junk and closing brace precede the block', () => {
    const raw = `}
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "headers": { "CONTEXT7_API_KEY": "k" }
    }
}`
    const r = parseMcpImportText(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.mcpServers['context7']).toMatchObject({
      url: 'https://mcp.context7.com/mcp',
      headers: { CONTEXT7_API_KEY: 'k' },
    })
  })

  it('prefers second JSON object when first has no mcpServers', () => {
    const raw = `{"noise":1}{"mcpServers":{"a":{"url":"https://example/mcp"}}}`
    const r = parseMcpImportText(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.mcpServers['a']).toMatchObject({ url: 'https://example/mcp' })
  })

  it('extractBalancedJsonObject returns inner object from index', () => {
    const t = 'pre {"mcpServers": {"x": {"url": "u"}}} post'
    const brace = t.indexOf('{', t.indexOf('"mcpServers"'))
    const obj = extractBalancedJsonObject(t, brace)
    expect(obj).toBe('{"x": {"url": "u"}}')
  })
})
