import { resolve } from 'node:path'
import { BenchmarkMcpClient } from './lib/mcp-client.js'
import { loadEffectiveBenchmarkConfig } from './lib/effective-config.js'
import {
  generateDatasetFromRegistry,
  writePreparedArtifacts,
  type DatasetPreparationDiagnostics,
} from './lib/local-dataset.js'
import { createEffectiveBenchmarkRuntime } from './lib/local-runtime.js'
import { runBenchmark } from './runner.js'

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current?.startsWith('--')) continue
    const key = current.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true'
      continue
    }
    parsed[key] = next
    index += 1
  }
  return parsed
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const configPath = resolve(args['config'] ?? './config')
  const outputDir = resolve(args['output-dir'] ?? './bench/datasets/local')
  const authHeader = args['auth-header'] ?? process.env['BENCH_AUTH_HEADER']
  const effective = await loadEffectiveBenchmarkConfig(configPath, args['database'])
  const runtime = await createEffectiveBenchmarkRuntime(effective.config)

  try {
    const generated = generateDatasetFromRegistry(effective.config, runtime.registry, {
      authHeader,
      datasetName: args['dataset-name'],
      maxScenariosPerServer: Number(args['max-per-server'] ?? 2),
    })
    const mcpChecks = await probeNamespaces(runtime, effective.config, authHeader)
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
    let benchmarkSummary: Record<string, unknown> | undefined

    if (artifacts.datasetPath && args['run'] === 'true') {
      const result = await runBenchmark([
        '--config', configPath,
        '--dataset', artifacts.datasetPath,
        ...(authHeader ? ['--auth-header', authHeader] : []),
      ])
      benchmarkSummary = {
        reportJson: result.reportJsonPath,
        reportMarkdown: result.reportMarkdownPath,
        gateway: result.report.retrieval.gateway,
        baseline: result.report.retrieval.baseline,
      }
    }

    console.log(JSON.stringify({
      effectiveConfig: diagnostics.config,
      diagnosticsPath: artifacts.diagnosticsPath,
      datasetPath: artifacts.datasetPath,
      scenarioCount: generated.dataset.scenarios.length,
      mcpChecks,
      benchmark: benchmarkSummary,
    }, null, 2))
  } finally {
    await runtime.close()
  }
}

async function probeNamespaces(
  runtime: Awaited<ReturnType<typeof createEffectiveBenchmarkRuntime>>,
  config: Awaited<ReturnType<typeof loadEffectiveBenchmarkConfig>>['config'],
  authHeader?: string,
): Promise<DatasetPreparationDiagnostics['mcpChecks']> {
  const checks: DatasetPreparationDiagnostics['mcpChecks'] = []
  for (const namespace of Object.keys(config.namespaces).sort()) {
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

const isDirectExecution = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))

if (isDirectExecution) {
  await main()
}
