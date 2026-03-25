import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRealUsageBenchmarkFixture } from './fixtures/real-usage-benchmark.js'
import { createSmokeFixture } from './fixtures/smoke.js'
import { loadBenchmarkDataset } from './lib/dataset.js'
import { loadEffectiveBenchmarkConfig } from './lib/effective-config.js'
import { BenchmarkMcpClient } from './lib/mcp-client.js'
import { runE2ECase, runRetrievalCase } from './lib/executor.js'
import { summarizeE2E, summarizeRetrieval, renderMarkdownReport } from './lib/metrics.js'
import { createBenchmarkRuntime } from './lib/runtime.js'
import { createEffectiveBenchmarkRuntime } from './lib/local-runtime.js'
import type { BenchmarkReport, BenchmarkScenario } from './types.js'
import { getConfig } from '../src/config/index.js'
import type { DownstreamRegistry } from '../src/registry/registry.js'

type BenchmarkRuntime = Awaited<ReturnType<typeof createBenchmarkRuntime>>

export type BenchmarkRunResult = {
  report: BenchmarkReport
  reportJsonPath: string
  reportMarkdownPath: string
}

export async function runBenchmarkCore(
  scenarios: BenchmarkScenario[],
  runtime: BenchmarkRuntime,
  options: { reportDir: string; label: string; description?: string },
): Promise<BenchmarkRunResult> {
  const retrievalCases = []
  const e2eCases = []

  for (const scenario of scenarios) {
    const inject = (input: Parameters<typeof runtime.app.inject>[0]) => runtime.app.inject(input)
    const client = new BenchmarkMcpClient(inject, scenario.namespace, scenario.authHeader)
    retrievalCases.push(await runRetrievalCase(client, runtime.registry, scenario))
    e2eCases.push(await runE2ECase(client, runtime.registry, scenario))
  }

  const report: BenchmarkReport = {
    dataset: {
      name: options.label,
      description: options.description,
      scenarioCount: scenarios.length,
    },
    generatedAt: new Date().toISOString(),
    retrieval: {
      gateway: summarizeRetrieval(retrievalCases, 'gateway'),
      codeMode: summarizeRetrieval(retrievalCases, 'codeMode'),
      baseline: summarizeRetrieval(retrievalCases, 'baseline'),
      cases: retrievalCases,
    },
    e2e: {
      gateway: summarizeE2E(e2eCases, 'gateway'),
      codeMode: summarizeE2E(e2eCases, 'codeMode'),
      baseline: summarizeE2E(e2eCases, 'baseline'),
      cases: e2eCases,
    },
  }

  mkdirSync(options.reportDir, { recursive: true })
  const reportBase = `${options.label}-${Date.now()}`
  const jsonPath = resolve(options.reportDir, `${reportBase}.json`)
  const mdPath = resolve(options.reportDir, `${reportBase}.md`)
  writeFileSync(jsonPath, JSON.stringify(report, null, 2))
  writeFileSync(mdPath, renderMarkdownReport(report))

  return { report, reportJsonPath: jsonPath, reportMarkdownPath: mdPath }
}

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

export async function runBenchmark(argv: string[] = process.argv.slice(2)): Promise<{
  report: BenchmarkReport
  reportJsonPath: string
  reportMarkdownPath: string
  configPath: string
  configSource?: string
  activeVersion?: number
}> {
  const args = parseArgs(argv)
  const fixture = args['fixture'] === 'smoke'
    ? await createSmokeFixture()
    : args['fixture'] === 'real_usage_benchmark'
      ? await createRealUsageBenchmarkFixture()
      : undefined
  const configPath = fixture?.configDir ?? resolve(args['config'] ?? process.env['CONFIG_PATH'] ?? './config')
  const defaultDataset = args['fixture'] === 'real_usage_benchmark'
    ? './bench/datasets/public/real-usage-benchmark.json'
    : './bench/datasets/public/smoke.json'
  const datasetPath = resolve(args['dataset'] ?? defaultDataset)
  const reportDir = resolve(args['report-dir'] ?? './bench/results')
  const authHeader = args['auth-header'] ?? fixture?.authHeader ?? process.env['BENCH_AUTH_HEADER']
  const databasePath = args['database']

  const runtimeMeta = fixture
    ? {
        runtime: await createBenchmarkRuntime(configPath),
        configSource: 'fixture',
        activeVersion: undefined,
      }
    : await (async () => {
        const effective = await loadEffectiveBenchmarkConfig(configPath, databasePath)
        return {
          runtime: await createEffectiveBenchmarkRuntime(effective.config),
          configSource: effective.source,
          activeVersion: effective.activeVersion,
        }
      })()

  const runtime = runtimeMeta.runtime
  try {
    const dataset = loadBenchmarkDataset(datasetPath)
    assertBenchmarkReadiness(runtime.registry, dataset)
    const scenarios = dataset.scenarios.map((scenario) => ({
      ...scenario,
      authHeader: scenario.authHeader ?? authHeader,
    }))
    const coreResult = await runBenchmarkCore(scenarios, runtime, {
      reportDir,
      label: dataset.name,
      description: dataset.description,
    })
    return {
      ...coreResult,
      configPath,
      configSource: runtimeMeta.configSource,
      activeVersion: runtimeMeta.activeVersion,
    }
  } finally {
    await runtime.close()
    await fixture?.close()
  }
}

async function main(): Promise<void> {
  const result = await runBenchmark()
  console.log(JSON.stringify({
    dataset: result.report.dataset.name,
    configPath: result.configPath,
    configSource: result.configSource,
    activeVersion: result.activeVersion,
    reportJson: result.reportJsonPath,
    reportMarkdown: result.reportMarkdownPath,
    gateway: {
      retrieval: result.report.retrieval.gateway,
      e2e: result.report.e2e.gateway,
    },
    codeMode: {
      retrieval: result.report.retrieval.codeMode,
      e2e: result.report.e2e.codeMode,
    },
    baseline: {
      retrieval: result.report.retrieval.baseline,
      e2e: result.report.e2e.baseline,
    },
    publication: getConfig().selector.publication,
  }, null, 2))
}

function assertBenchmarkReadiness(
  registry: DownstreamRegistry,
  dataset: ReturnType<typeof loadBenchmarkDataset>,
): void {
  const namespaceSummaries = new Map<string, { toolCount: number; toolNames: Set<string> }>()

  for (const scenario of dataset.scenarios) {
    if (namespaceSummaries.has(scenario.namespace)) continue
    const groups = registry.getToolsByNamespace(scenario.namespace)
    const toolNames = new Set<string>()
    let toolCount = 0
    for (const group of groups) {
      toolCount += group.records.length
      for (const record of group.records) {
        toolNames.add(record.name)
      }
    }
    namespaceSummaries.set(scenario.namespace, { toolCount, toolNames })
  }

  const errors: string[] = []
  for (const [namespace, summary] of namespaceSummaries.entries()) {
    if (summary.toolCount === 0) {
      errors.push(`Namespace '${namespace}' has no tools loaded in the benchmark runtime`)
    }
  }

  for (const scenario of dataset.scenarios) {
    const summary = namespaceSummaries.get(scenario.namespace)
    if (!summary || summary.toolCount === 0) continue
    const missingExpectedTools = scenario.expectedTools.filter((tool) => !summary.toolNames.has(tool))
    if (missingExpectedTools.length > 0) {
      errors.push(
        `Scenario '${scenario.id}' expects tools not present in namespace '${scenario.namespace}': ${missingExpectedTools.join(', ')}`,
      )
    }
  }

  if (errors.length > 0) {
    throw new Error(`Benchmark readiness failed:\n- ${errors.join('\n- ')}`)
  }
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))

if (isDirectExecution) {
  await main()
}
