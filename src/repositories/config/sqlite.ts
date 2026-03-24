import { eq, desc, sql } from 'drizzle-orm'
import type { SqliteDb } from '../../db/index.js'
import { configVersions } from '../../db/adapters/sqlite/schema.js'
import type { IConfigRepository, ConfigVersionMeta, ConfigVersionSummary } from './interface.js'
import type { AdminConfig } from '../../config/loader.js'

export class SqliteConfigRepository implements IConfigRepository {
  constructor(private readonly db: SqliteDb) {}

  async getActive(): Promise<AdminConfig | undefined> {
    const rows = this.db
      .select()
      .from(configVersions)
      .where(eq(configVersions.isActive, 1))
      .limit(1)
      .all()

    if (rows.length === 0) return undefined
    const raw = JSON.parse(rows[0].configJson) as AdminConfig
    // Migrate legacy namespace: string → namespaces: string[]
    if (Array.isArray(raw?.servers)) {
      for (const s of raw.servers as Record<string, unknown>[]) {
        if (typeof s['namespace'] === 'string' && !Array.isArray(s['namespaces'])) {
          s['namespaces'] = [s['namespace']]
          delete s['namespace']
        }
      }
    }
    return raw
  }

  async save(config: AdminConfig, meta: ConfigVersionMeta): Promise<number> {
    const now = Date.now()

    const lastVersionRows = this.db
      .select({ maxVersion: sql<number>`MAX(version)`.as('max_version') })
      .from(configVersions)
      .all()

    const nextVersion = (Number(lastVersionRows[0]?.maxVersion ?? 0)) + 1

    this.db.update(configVersions).set({ isActive: 0 }).where(eq(configVersions.isActive, 1)).run()

    this.db.insert(configVersions).values({
      version:    nextVersion,
      configJson: JSON.stringify(config),
      source:     meta.source,
      createdBy:  meta.createdBy,
      createdAt:  now,
      comment:    meta.comment ?? null,
      isActive:   1,
    }).run()

    return nextVersion
  }

  async listVersions(): Promise<ConfigVersionSummary[]> {
    const rows = this.db
      .select()
      .from(configVersions)
      .orderBy(desc(configVersions.version))
      .all()

    return rows.map(row => ({
      id:        row.id,
      version:   row.version,
      source:    row.source,
      createdBy: row.createdBy,
      createdAt: new Date(row.createdAt),
      comment:   row.comment ?? undefined,
      isActive:  row.isActive === 1,
    }))
  }

  async rollback(version: number): Promise<void> {
    const target = this.db
      .select()
      .from(configVersions)
      .where(eq(configVersions.version, version))
      .limit(1)
      .all()

    if (target.length === 0) {
      throw new Error(`[config] Version ${version} not found`)
    }

    this.db.update(configVersions).set({ isActive: 0 }).where(eq(configVersions.isActive, 1)).run()
    this.db.update(configVersions).set({ isActive: 1 }).where(eq(configVersions.version, version)).run()
  }
}
