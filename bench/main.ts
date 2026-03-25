import { resolve } from 'node:path'
import { createSmokeFixture } from './fixtures/smoke.js'
import { createBenchmarkRuntime } from './lib/runtime.js'
import { createEffectiveBenchmarkRuntime } from './lib/local-runtime.js'
import { loadEffectiveBenchmarkConfig } from './lib/effective-config.js'
import { generateDatasetFromRegistry } from './lib/local-dataset.js'
import { runBenchmarkCore, type BenchmarkRunResult } from './runner.js'
import { getConfig } from '../src/config/index.js'

const REPORT_DIR = resolve('./bench/results')
const subcommand = process.argv[2] ?? 'all'

if (subcommand === 'smoke') {
  await runSmoke()
} else if (subcommand === 'all') {
  await runAll()
} else {
  console.error(`Unknown subcommand: ${JSON.stringify(subcommand)}. Use 'smoke' or 'all'.`)
  process.exit(1)
}

async function runSmoke(): Promise<void> {
  const fixture = await createSmokeFixture()
  const runtime = await createBenchmarkRuntime(fixture.configDir)
  try {
    const config = getConfig()
    const { dataset } = generateDatasetFromRegistry(config, runtime.registry, {
      authHeader: fixture.authHeader,
      datasetName: 'smoke',
      maxScenariosPerServer: 3,
    })
    // Use 'work' (compat) as primary namespace and 'work-code' as code mode namespace per scenario
    const scenarios = dataset.scenarios
      .filter((s) => s.namespace === 'work')
      .map((s) => ({ ...s, codeModeNamespace: 'work-code' }))
    if (scenarios.length === 0) {
      console.error('No scenarios generated from smoke fixture — check registry state')
      process.exit(1)
    }
    const result = await runBenchmarkCore(scenarios, runtime, {
      reportDir: REPORT_DIR,
      label: 'smoke',
      description: dataset.description,
    })
    printSummary(result)
  } finally {
    await runtime.close()
    await fixture.close()
  }
}

async function runAll(): Promise<void> {
  const configPath = resolve(process.env['CONFIG_PATH'] ?? './config')
  const databasePath = process.env['DATABASE_PATH']
  const authHeader = process.env['BENCH_AUTH_HEADER']
  const effective = await loadEffectiveBenchmarkConfig(configPath, databasePath)
  const runtime = await createEffectiveBenchmarkRuntime(effective.config)
  try {
    const { dataset, diagnostics } = generateDatasetFromRegistry(effective.config, runtime.registry, {
      authHeader,
      datasetName: `all-${new Date().toISOString().slice(0, 10)}`,
      maxScenariosPerServer: 3,
    })
    if (diagnostics.generation.skippedServerCount > 0) {
      console.warn(
        `Skipped ${diagnostics.generation.skippedServerCount} server(s) with no tools: ${diagnostics.generation.skippedServers.join(', ')}`,
      )
    }
    if (dataset.scenarios.length === 0) {
      console.error('No scenarios generated — check registry is running and configured correctly')
      process.exit(1)
    }
    const result = await runBenchmarkCore(dataset.scenarios, runtime, {
      reportDir: REPORT_DIR,
      label: dataset.name,
      description: dataset.description,
    })
    printSummary(result)
  } finally {
    await runtime.close()
  }
}

function printSummary(result: BenchmarkRunResult): void {
  const { report, reportJsonPath, reportMarkdownPath } = result
  console.log(JSON.stringify({
    scenarios: report.dataset.scenarioCount,
    retrieval: {
      gateway: {
        recallAt3: report.retrieval.gateway.recallAt3,
        mrr: report.retrieval.gateway.meanReciprocalRank,
        avgTokens: report.retrieval.gateway.averageTotalTokens,
      },
      codeMode: {
        recallAt3: report.retrieval.codeMode.recallAt3,
        mrr: report.retrieval.codeMode.meanReciprocalRank,
        avgTokens: report.retrieval.codeMode.averageTotalTokens,
      },
      baseline: {
        recallAt3: report.retrieval.baseline.recallAt3,
        mrr: report.retrieval.baseline.meanReciprocalRank,
        avgTokens: report.retrieval.baseline.averageTotalTokens,
      },
    },
    e2e: {
      gateway: {
        successRate: report.e2e.gateway.successRate,
        avgContextTokens: report.e2e.gateway.averageTotalContextTokens,
        avgLatencyMs: report.e2e.gateway.averageLatencyMs,
      },
      codeMode: {
        successRate: report.e2e.codeMode.successRate,
        avgContextTokens: report.e2e.codeMode.averageTotalContextTokens,
        avgLatencyMs: report.e2e.codeMode.averageLatencyMs,
      },
      baseline: {
        successRate: report.e2e.baseline.successRate,
        avgContextTokens: report.e2e.baseline.averageTotalContextTokens,
        avgLatencyMs: report.e2e.baseline.averageLatencyMs,
      },
    },
    reports: {
      json: reportJsonPath,
      markdown: reportMarkdownPath,
    },
  }, null, 2))
}
