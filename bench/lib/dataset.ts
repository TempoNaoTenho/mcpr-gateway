import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BenchmarkDatasetSchema, type BenchmarkDataset } from '../types.js'

export function loadBenchmarkDataset(datasetPath: string): BenchmarkDataset {
  const fullPath = resolve(datasetPath)
  const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as unknown
  return BenchmarkDatasetSchema.parse(parsed)
}
