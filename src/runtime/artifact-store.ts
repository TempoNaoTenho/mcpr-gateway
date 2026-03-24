import { nanoid } from 'nanoid'
import { summarize } from './result-api.js'

export type ArtifactSummary = {
  ref: string
  label?: string
  byteSize: number
  createdAt: string
  expiresAt: string
  preview: ReturnType<typeof summarize>
}

type ArtifactRecord = ArtifactSummary & {
  data: unknown
}

function toByteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, ArtifactRecord>()

  save(data: unknown, options: { label?: string; ttlSeconds: number }): ArtifactSummary {
    this.cleanupExpired()

    const now = Date.now()
    const ref = `artifact_${nanoid(10)}`
    const byteSize = toByteSize(data)
    const record: ArtifactRecord = {
      ref,
      label: options.label,
      byteSize,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + options.ttlSeconds * 1000).toISOString(),
      preview: summarize(data),
      data,
    }
    this.artifacts.set(ref, record)
    return this.toSummary(record)
  }

  list(): ArtifactSummary[] {
    this.cleanupExpired()
    return [...this.artifacts.values()].map((record) => this.toSummary(record))
  }

  get(ref: string): ArtifactRecord | undefined {
    this.cleanupExpired()
    return this.artifacts.get(ref)
  }

  private cleanupExpired(): void {
    const now = Date.now()
    for (const [ref, record] of this.artifacts.entries()) {
      if (Date.parse(record.expiresAt) <= now) {
        this.artifacts.delete(ref)
      }
    }
  }

  private toSummary(record: ArtifactRecord): ArtifactSummary {
    return {
      ref: record.ref,
      label: record.label,
      byteSize: record.byteSize,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      preview: record.preview,
    }
  }
}

export const artifactStore = new ArtifactStore()
