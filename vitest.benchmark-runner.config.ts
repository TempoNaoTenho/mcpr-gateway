import { defineConfig } from 'vitest/config'

/** Opt-in integration checks for `runBenchmark` (writes under bench/reports/). */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['bench/benchmark-runner.test.ts'],
  },
})
