import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyDotEnvFromRoot } from '../scripts/load-dotenv.mjs'
import { GatewayMode } from '../src/types/enums.js'
import { runBenchmark } from './runner.js'
import { loadEffectiveBenchmarkConfig } from './lib/effective-config.js'
import { summarizeReportNamespace } from './lib/metrics.js'
import {
  generateDatasetFromRegistry,
  writePreparedArtifacts,
  type DatasetPreparationDiagnostics,
} from './lib/local-dataset.js'
import { createEffectiveBenchmarkRuntime } from './lib/local-runtime.js'
import {
  buildNamespaceModeSummary,
  modeMetricKey,
  parseCliArgs,
  parseGatewayModesFlag,
  parseListFlag,
  parsePositiveIntFlag,
  renderHelpText,
  validateNodeMajor,
} from './cli-support.js'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main(): Promise<void> {
  applyDotEnvFromRoot(ROOT_DIR)
  const cli = parseCliArgs(process.argv.slice(2))

  if (cli.command === 'help' || cli.flags['help'] === 'true') {
    if (cli.positionals[0] && cli.command === 'help' && cli.positionals[0] !== 'help') {
      throw new Error(`Unknown benchmark command: ${JSON.stringify(cli.positionals[0])}\n\n${renderHelpText()}`)
    }
    console.log(renderHelpText())
    return
  }

  if (cli.command === 'smoke') {
    const result = await runBenchmark(['--fixture', 'smoke', ...forwardSharedFlags(cli.flags)])
    printSmokeSummary(result)
    return
  }

  await runNativePreflight()

  if (cli.command === 'prepare') {
    const prepared = await prepareLocalBenchmark(cli.flags)
    const shouldRun = cli.flags['run'] === 'true'
    let runResult: Awaited<ReturnType<typeof runBenchmark>> | undefined
    if (shouldRun && prepared.artifacts.datasetPath) {
      runResult = await runPreparedDataset(prepared)
    }
    printPreparedSummary(prepared, runResult)
    return
  }

  if (cli.command === 'real') {
    const namespaces = parseListFlag(cli.flags['namespaces'])
    if (namespaces.length === 0) {
      throw new Error('The real benchmark requires --namespaces ns1,ns2')
    }
    const prepared = await prepareLocalBenchmark(cli.flags, { requireNamespaces: true })
    if (!prepared.artifacts.datasetPath) {
      throw new Error('No runnable scenarios were generated for the selected namespaces.')
    }

    const result = await runPreparedDataset(prepared)

    printRealSummary(prepared, result.report, {
      json: result.reportJsonPath,
      markdown: result.reportMarkdownPath,
    })
    return
  }

  throw new Error(renderHelpText())
}

async function prepareLocalBenchmark(
  flags: Record<string, string>,
  options?: { requireNamespaces?: boolean },
): Promise<{
  config: Awaited<ReturnType<typeof loadEffectiveBenchmarkConfig>>
  diagnostics: DatasetPreparationDiagnostics
  artifacts: ReturnType<typeof writePreparedArtifacts>
  authHeader?: string
  reportDir: string
  compareSummary: ReturnType<typeof buildNamespaceModeSummary>
}> {
  const configPath = resolve(flags['config'] ?? process.env['CONFIG_PATH'] ?? './config')
  const databasePath = flags['database'] ?? process.env['DATABASE_PATH']
  const outputDir = resolve(flags['output-dir'] ?? './bench/datasets/local')
  const reportDir = resolve(flags['report-dir'] ?? './bench/results')
  const authHeader = flags['auth-header'] ?? process.env['BENCH_AUTH_HEADER']
  const requestedNamespaces = parseListFlag(flags['namespaces'])
  const selectedServerIds = parseListFlag(flags['server-ids'])
  const compareModes = parseGatewayModesFlag(flags['compare-modes'])
  const maxPerServer = parsePositiveIntFlag(flags['max-per-server'], 2, '--max-per-server')
  const toolPattern = flags['tool-pattern']

  if (options?.requireNamespaces && requestedNamespaces.length === 0) {
    throw new Error('At least one namespace must be provided via --namespaces.')
  }

  const effective = await loadEffectiveBenchmarkConfig(configPath, databasePath)
  const runtime = await createEffectiveBenchmarkRuntime(effective.config)

  try {
    const allNamespaces = Object.keys(effective.config.namespaces).sort()
    const namespaces = requestedNamespaces.length > 0 ? requestedNamespaces : allNamespaces
    const missingNamespaces = namespaces.filter((namespace) => effective.config.namespaces[namespace] === undefined)
    if (missingNamespaces.length > 0) {
      throw new Error(`Unknown namespaces: ${missingNamespaces.join(', ')}`)
    }

    const generated = generateDatasetFromRegistry(effective.config, runtime.registry, {
      authHeader,
      datasetName: buildDatasetName(namespaces),
      maxScenariosPerServer: maxPerServer,
      namespaces,
      serverIds: selectedServerIds,
      toolPattern,
    })

    const mcpChecks = await probeNamespaces(runtime, effective.config, authHeader, namespaces)
    const diagnostics: DatasetPreparationDiagnostics = {
      config: {
        source: effective.source,
        configPath: effective.configPath,
        databasePath: effective.databasePath,
        activeVersion: effective.activeVersion,
      },
      namespaces: generated.diagnostics.namespaces,
      servers: generated.diagnostics.servers,
      mcpChecks,
      generation: generated.diagnostics.generation,
    }

    const artifacts = writePreparedArtifacts(outputDir, generated.dataset, diagnostics)
    const compare = buildNamespaceModeSummary(
      namespaces,
      Object.fromEntries(namespaces.map((namespace) => [namespace, effective.config.namespaces[namespace]?.gatewayMode ?? GatewayMode.Compat])),
      compareModes,
    )

    const emptyNamespaces = generated.diagnostics.namespaces
      .filter((namespace) => namespace.toolCount === 0)
      .map((namespace) => namespace.name)
    if (emptyNamespaces.length > 0) {
      throw new Error(`Selected namespaces have no tools loaded: ${emptyNamespaces.join(', ')}`)
    }

    const noRunnableModes = compare.filter((entry) => entry.runnableModes.length === 0).map((entry) => entry.namespace)
    if (noRunnableModes.length > 0) {
      throw new Error(`No runnable benchmark modes for namespaces: ${noRunnableModes.join(', ')}`)
    }

    return {
      config: effective,
      diagnostics,
      artifacts,
      authHeader,
      reportDir,
      compareSummary: compare,
    }
  } finally {
    await runtime.close()
  }
}

async function probeNamespaces(
  runtime: Awaited<ReturnType<typeof createEffectiveBenchmarkRuntime>>,
  config: Awaited<ReturnType<typeof loadEffectiveBenchmarkConfig>>['config'],
  authHeader: string | undefined,
  namespaces: string[],
): Promise<DatasetPreparationDiagnostics['mcpChecks']> {
  const { BenchmarkMcpClient } = await import('./lib/mcp-client.js')
  const checks: DatasetPreparationDiagnostics['mcpChecks'] = []
  for (const namespace of namespaces) {
    if (!config.namespaces[namespace]) continue
    const client = new BenchmarkMcpClient(
      (input) => runtime.app.inject(input),
      namespace,
      authHeader,
    )

    try {
      const { sessionId } = await client.initialize('read')
      const tools = await client.toolsList(sessionId)
      checks.push({
        namespace,
        sessionCreated: true,
        visibleToolCount: tools.length,
        visibleToolNames: tools.slice(0, 10).map((tool) => tool.name),
      })
    } catch (error) {
      checks.push({
        namespace,
        sessionCreated: false,
        visibleToolCount: 0,
        visibleToolNames: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return checks
}

async function runNativePreflight(): Promise<void> {
  const nodeCheck = validateNodeMajor(process.version)
  if (!nodeCheck.ok) {
    throw new Error(`Benchmark commands require Node 22 or 24 LTS. Current version: ${process.version}`)
  }

  try {
    await import('better-sqlite3')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to load better-sqlite3. Rebuild dependencies for the active Node version.\n${message}`)
  }
}

function printPreparedSummary(
  prepared: Awaited<ReturnType<typeof prepareLocalBenchmark>>,
  runResult?: Awaited<ReturnType<typeof runBenchmark>>,
): void {
  const lines = [
    'Benchmark dataset prepared.',
    `Config source: ${prepared.config.source}`,
    `Config path: ${prepared.config.configPath}`,
  ]
  if (prepared.config.databasePath) {
    lines.push(`Database path: ${prepared.config.databasePath}`)
  }
  lines.push(`Diagnostics: ${prepared.artifacts.diagnosticsPath}`)
  if (prepared.artifacts.datasetPath) {
    lines.push(`Dataset: ${prepared.artifacts.datasetPath}`)
  } else {
    lines.push('Dataset: no scenarios generated')
  }
  lines.push(`Scenarios: ${prepared.diagnostics.generation.scenarioCount}`)
  for (const namespace of prepared.diagnostics.namespaces) {
    lines.push(`- ${namespace.name}: ${namespace.toolCount} tools across ${namespace.serverCount} servers`)
  }
  if (runResult) {
    lines.push(`Report JSON: ${runResult.reportJsonPath}`)
    lines.push(`Report Markdown: ${runResult.reportMarkdownPath}`)
  }
  console.log(lines.join('\n'))
}

function printRealSummary(
  prepared: Awaited<ReturnType<typeof prepareLocalBenchmark>>,
  report: Awaited<ReturnType<typeof runBenchmark>>['report'],
  reports: { json: string; markdown: string },
): void {
  const lines = [
    'Benchmark completed.',
    `Config source: ${prepared.config.source}`,
    `Scenarios: ${report.dataset.scenarioCount}`,
    `Dataset: ${prepared.artifacts.datasetPath ?? 'in-memory only'}`,
    `Diagnostics: ${prepared.artifacts.diagnosticsPath}`,
    `Report JSON: ${reports.json}`,
    `Report Markdown: ${reports.markdown}`,
    '',
    'Mode comparison:',
  ]

  for (const summary of prepared.compareSummary) {
    lines.push(`- ${summary.namespace} (configured ${summary.configuredMode})`)
    for (const mode of summary.runnableModes) {
      const scoped = summarizeReportNamespace(report, summary.namespace, modeMetricKey(mode))
      if (scoped.retrieval.scenarioCount === 0 || scoped.e2e.scenarioCount === 0) {
        lines.push(`  ${mode}: no scenarios for this namespace`)
        continue
      }
      lines.push(
        `  ${mode}: retrieval recall@3=${scoped.retrieval.recallAt3}, mrr=${scoped.retrieval.meanReciprocalRank}, e2e success=${scoped.e2e.successRate}, avg context=${scoped.e2e.averageTotalContextTokens}`,
      )
    }
    for (const skipped of summary.skippedModes) {
      lines.push(`  ${skipped.mode}: skipped (${skipped.reason})`)
    }
  }

  console.log(lines.join('\n'))
}

function printSmokeSummary(
  result: Awaited<ReturnType<typeof runBenchmark>>,
): void {
  console.log([
    'Smoke benchmark completed.',
    `Dataset: ${result.report.dataset.name}`,
    `Scenarios: ${result.report.dataset.scenarioCount}`,
    `Report JSON: ${result.reportJsonPath}`,
    `Report Markdown: ${result.reportMarkdownPath}`,
  ].join('\n'))
}

function buildDatasetName(namespaces: string[]): string {
  const date = new Date().toISOString().slice(0, 10)
  const label = namespaces.join('-').replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-')
  return `real-${label || 'all'}-${date}`
}

async function runPreparedDataset(
  prepared: Awaited<ReturnType<typeof prepareLocalBenchmark>>,
): Promise<Awaited<ReturnType<typeof runBenchmark>>> {
  if (!prepared.artifacts.datasetPath) {
    throw new Error('No runnable dataset was generated.')
  }
  return runBenchmark([
    '--config', prepared.config.configPath,
    '--dataset', prepared.artifacts.datasetPath,
    '--report-dir', prepared.reportDir,
    ...(prepared.config.databasePath ? ['--database', prepared.config.databasePath] : []),
    ...(prepared.authHeader ? ['--auth-header', prepared.authHeader] : []),
  ])
}

function forwardSharedFlags(flags: Record<string, string>): string[] {
  const supported = ['report-dir', 'auth-header']
  const forwarded: string[] = []
  for (const key of supported) {
    const value = flags[key]
    if (!value) continue
    forwarded.push(`--${key}`, value)
  }
  return forwarded
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))

if (isDirectExecution) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  })
}
