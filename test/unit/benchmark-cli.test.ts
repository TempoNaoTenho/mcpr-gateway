import { describe, expect, it } from 'vitest'
import { GatewayMode } from '../../src/types/enums.js'
import {
  buildNamespaceModeSummary,
  modeMetricKey,
  parseCliArgs,
  parseGatewayModesFlag,
  parseListFlag,
  parsePositiveIntFlag,
  validateNodeMajor,
} from '../../bench/cli-support.js'

describe('benchmark CLI support', () => {
  it('parses command, flags, and positionals', () => {
    const parsed = parseCliArgs(['real', '--namespaces', 'research,prod', '--max-per-server=3'])
    expect(parsed.command).toBe('real')
    expect(parsed.flags['namespaces']).toBe('research,prod')
    expect(parsed.flags['max-per-server']).toBe('3')
  })

  it('parses list and mode flags', () => {
    expect(parseListFlag('research, prod, research')).toEqual(['research', 'prod'])
    expect(parseGatewayModesFlag('default,compat,code')).toEqual([
      GatewayMode.Default,
      GatewayMode.Compat,
      GatewayMode.Code,
    ])
  })

  it('rejects invalid mode and integer flags', () => {
    expect(() => parseGatewayModesFlag('compat,unknown')).toThrow(/Invalid gateway modes/)
    expect(() => parsePositiveIntFlag('0', 2, '--max-per-server')).toThrow(/positive integer/)
  })

  it('validates supported node majors', () => {
    expect(validateNodeMajor('v22.11.0')).toEqual({ ok: true, major: 22 })
    expect(validateNodeMajor('v25.1.0')).toEqual({ ok: false, major: 25 })
  })

  it('builds namespace mode summary with compat skips', () => {
    const summary = buildNamespaceModeSummary(
      ['research', 'default-only'],
      {
        research: GatewayMode.Compat,
        'default-only': GatewayMode.Default,
      },
      [GatewayMode.Compat, GatewayMode.Default, GatewayMode.Code],
    )

    expect(summary[0]?.runnableModes).toEqual([
      GatewayMode.Compat,
      GatewayMode.Default,
      GatewayMode.Code,
    ])
    expect(summary[1]?.runnableModes).toEqual([GatewayMode.Default, GatewayMode.Code])
    expect(summary[1]?.skippedModes[0]?.mode).toBe(GatewayMode.Compat)
    expect(modeMetricKey(GatewayMode.Default)).toBe('baseline')
    expect(modeMetricKey(GatewayMode.Compat)).toBe('gateway')
    expect(modeMetricKey(GatewayMode.Code)).toBe('codeMode')
  })

  it('deduplicates default requested modes for default and code namespaces', () => {
    const summary = buildNamespaceModeSummary(
      ['code-ns', 'default-ns'],
      {
        'code-ns': GatewayMode.Code,
        'default-ns': GatewayMode.Default,
      },
    )

    expect(summary[0]?.runnableModes).toEqual([GatewayMode.Code, GatewayMode.Default])
    expect(summary[1]?.runnableModes).toEqual([GatewayMode.Default, GatewayMode.Code])
  })
})
