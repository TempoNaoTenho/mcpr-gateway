import { GatewayMode } from '../src/types/enums.js'

export type BenchmarkCliCommand = 'help' | 'smoke' | 'real' | 'prepare'

export type BenchmarkCliArgs = {
  command: BenchmarkCliCommand
  flags: Record<string, string>
  positionals: string[]
}

export type NamespaceModeSummary = {
  namespace: string
  configuredMode: GatewayMode
  requestedModes: GatewayMode[]
  runnableModes: GatewayMode[]
  skippedModes: Array<{ mode: GatewayMode; reason: string }>
}

const VALID_COMMANDS = new Set<BenchmarkCliCommand>(['help', 'smoke', 'real', 'prepare'])
const GATEWAY_MODES = new Set<string>(Object.values(GatewayMode))

export function parseCliArgs(argv: string[]): BenchmarkCliArgs {
  const positionals: string[] = []
  const flags: Record<string, string> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current) continue

    if (current === '--help' || current === '-h') {
      return { command: 'help', flags: { help: 'true' }, positionals }
    }

    if (!current.startsWith('--')) {
      positionals.push(current)
      continue
    }

    const eqIndex = current.indexOf('=')
    if (eqIndex >= 0) {
      const key = current.slice(2, eqIndex)
      flags[key] = current.slice(eqIndex + 1)
      continue
    }

    const key = current.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      flags[key] = 'true'
      continue
    }

    flags[key] = next
    index += 1
  }

  const requested = positionals[0]
  const command = VALID_COMMANDS.has(requested as BenchmarkCliCommand)
    ? requested as BenchmarkCliCommand
    : requested === undefined
      ? 'help'
      : 'help'

  return {
    command,
    flags,
    positionals,
  }
}

export function parseListFlag(value?: string): string[] {
  if (!value) return []
  return [...new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )]
}

export function parseGatewayModesFlag(value?: string): GatewayMode[] {
  const modes = parseListFlag(value)
  const invalid = modes.filter((mode) => !GATEWAY_MODES.has(mode))
  if (invalid.length > 0) {
    throw new Error(`Invalid gateway modes: ${invalid.join(', ')}. Use default, compat, or code.`)
  }
  return modes as GatewayMode[]
}

export function parsePositiveIntFlag(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return parsed
}

export function validateNodeMajor(version: string): { ok: boolean; major: number } {
  const major = Number(version.replace(/^v/, '').split('.')[0] ?? 0)
  return {
    ok: major === 22 || major === 24,
    major,
  }
}

export function buildNamespaceModeSummary(
  namespaces: string[],
  configuredModes: Record<string, GatewayMode>,
  requestedModes?: GatewayMode[],
): NamespaceModeSummary[] {
  const explicitModes = requestedModes && requestedModes.length > 0 ? requestedModes : undefined

  return namespaces.map((namespace) => {
    const configuredMode = configuredModes[namespace] ?? GatewayMode.Compat
    const desiredModes = explicitModes ?? defaultRequestedModes(configuredMode)
    const runnableModes: GatewayMode[] = []
    const skippedModes: Array<{ mode: GatewayMode; reason: string }> = []

    for (const mode of desiredModes) {
      const reason = resolveModeSkipReason(mode, configuredMode)
      if (reason) {
        skippedModes.push({ mode, reason })
        continue
      }
      runnableModes.push(mode)
    }

    return {
      namespace,
      configuredMode,
      requestedModes: desiredModes,
      runnableModes,
      skippedModes,
    }
  })
}

export function modeMetricKey(mode: GatewayMode): 'baseline' | 'gateway' | 'codeMode' {
  if (mode === GatewayMode.Default) return 'baseline'
  if (mode === GatewayMode.Code) return 'codeMode'
  return 'gateway'
}

export function renderHelpText(): string {
  return [
    'MCPR Gateway benchmark CLI',
    '',
    'Usage:',
    '  npm run benchmark -- smoke',
    '  npm run benchmark -- real --namespaces research,prod',
    '  npm run benchmark -- prepare --namespaces research --run',
    '',
    'Commands:',
    '  smoke    Run the fixture-backed smoke benchmark.',
    '  real     Auto-generate a benchmark from the active runtime config and execute it.',
    '  prepare  Auto-generate dataset + diagnostics; optionally execute with --run.',
    '',
    'Common flags:',
    '  --namespaces       Comma-separated namespace list. Required for real; optional for prepare.',
    '  --compare-modes    Comma-separated modes to compare: default,compat,code.',
    '  --config           Config directory. Defaults to CONFIG_PATH or ./config.',
    '  --database         SQLite path. Defaults to DATABASE_PATH or ./data/gateway.db.',
    '  --auth-header      Bearer token used for benchmark initialize/tools calls.',
    '  --max-per-server   Max generated scenarios per downstream server.',
    '  --server-ids       Optional comma-separated downstream server IDs to include.',
    '  --tool-pattern     Optional RegExp used to keep matching tool names only.',
    '  --report-dir       Output directory for benchmark reports.',
    '  --output-dir       Output directory for generated dataset/diagnostics artifacts.',
    '  --run              For prepare, execute the generated dataset immediately.',
    '',
    'Notes:',
    '  - The CLI auto-loads .env from the repo root before resolving CONFIG_PATH and DATABASE_PATH.',
    '  - Compat metrics require the namespace to be configured in compat mode; other modes are reported as skipped.',
    '  - Default metrics map to the benchmark baseline exposure; code metrics map to the code-mode simulation.',
  ].join('\n')
}

function defaultRequestedModes(configuredMode: GatewayMode): GatewayMode[] {
  if (configuredMode === GatewayMode.Compat) {
    return [GatewayMode.Compat, GatewayMode.Default, GatewayMode.Code]
  }
  return [...new Set([configuredMode, GatewayMode.Default, GatewayMode.Code])]
}

function resolveModeSkipReason(mode: GatewayMode, configuredMode: GatewayMode): string | undefined {
  if (mode === GatewayMode.Compat && configuredMode !== GatewayMode.Compat) {
    return `compat metrics require a namespace currently configured in compat mode; configured as ${configuredMode}`
  }
  return undefined
}
