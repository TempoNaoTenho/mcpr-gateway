import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSmokeFixture } from '../../bench/fixtures/smoke.js'
import { loadEffectiveBenchmarkConfig } from '../../bench/lib/effective-config.js'
import { generateDatasetFromRegistry, writePreparedArtifacts } from '../../bench/lib/local-dataset.js'
import { createEffectiveBenchmarkRuntime } from '../../bench/lib/local-runtime.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.()
  }
})

describe('benchmark local preparation', () => {
  it('generates a runnable dataset from a live smoke fixture', async () => {
    const fixture = await createSmokeFixture()
    cleanup.push(() => fixture.close())

    const effective = await loadEffectiveBenchmarkConfig(
      fixture.configDir,
      join(tmpdir(), `missing-bench-db-${Date.now()}.sqlite`),
    )
    const runtime = await createEffectiveBenchmarkRuntime(effective.config)
    cleanup.push(() => runtime.close())

    const prepared = generateDatasetFromRegistry(effective.config, runtime.registry, {
      authHeader: fixture.authHeader,
      datasetName: 'smoke-prepared',
      maxScenariosPerServer: 1,
    })

    expect(prepared.dataset.scenarios.length).toBeGreaterThan(0)
    expect(prepared.diagnostics.generation.skippedServers).toHaveLength(0)

    const outputDir = join(tmpdir(), `mcp-gateway-bench-prep-${Date.now()}`)
    const artifacts = writePreparedArtifacts(outputDir, prepared.dataset, {
      config: {
        source: effective.source,
        configPath: effective.configPath,
        databasePath: effective.databasePath,
        activeVersion: effective.activeVersion,
      },
      namespaces: prepared.diagnostics.namespaces,
      servers: prepared.diagnostics.servers,
      mcpChecks: [],
      generation: prepared.diagnostics.generation,
    })

    expect(artifacts.datasetPath).toBeDefined()
    expect(existsSync(artifacts.datasetPath!)).toBe(true)

    const dataset = JSON.parse(readFileSync(artifacts.datasetPath!, 'utf8')) as { scenarios: Array<{ expectedTools: string[] }> }
    expect(dataset.scenarios[0]?.expectedTools.length).toBeGreaterThan(0)
  })
})
