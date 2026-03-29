import { describe, expect, it } from 'vitest'
import { buildGatewayHelp } from '../../src/runtime/help.js'
import { GatewayMode } from '../../src/types/enums.js'

describe('buildGatewayHelp', () => {
  it('documents safer catalog filters for code mode', () => {
    const help = buildGatewayHelp('catalog', GatewayMode.Code)

    expect(help.text).toContain('catalog.servers()')
    expect(help.text).toContain('catalog.search(query, { k, limit, serverId, risk, tags, requiredArgs, detail })')
    expect(help.text).toContain('requiredArgs: keep only tools whose required args include all listed fields')
    expect(help.text).toContain('detail=signature adds args, required, and a short properties map')
  })

  it('documents batch schema compatibility guidance', () => {
    const help = buildGatewayHelp('mcp', GatewayMode.Code)

    expect(help.text).toContain('Batch does not validate schema compatibility across handles')
    expect(help.text).toContain('if (tools.length < 2)')
    expect(help.text).toContain('requiredArgs: ["query"]')
  })

  it('documents content helpers for tool outputs', () => {
    const help = buildGatewayHelp('result', GatewayMode.Code)

    expect(help.text).toContain('result.items(value)')
    expect(help.text).toContain('result.text(value)')
    expect(help.text).toContain('return result.text(out)')
  })
})
