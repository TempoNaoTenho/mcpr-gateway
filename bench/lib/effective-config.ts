import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { initConfig, setConfig } from '../../src/config/index.js'
import { mergeWithAdminConfig, type GatewayConfig } from '../../src/config/loader.js'
import { openStandaloneSqlite } from '../../src/db/adapters/sqlite/index.js'
import { configVersions } from '../../src/db/adapters/sqlite/schema.js'
import { SqliteConfigRepository } from '../../src/repositories/config/sqlite.js'
import { defaultTestStaticKeys } from '../../test/fixtures/bootstrap-json.js'

export type EffectiveConfigLoadResult = {
  config: GatewayConfig
  configPath: string
  databasePath?: string
  source: 'bootstrap_file' | 'sqlite_active'
  activeVersion?: number
}

export async function loadEffectiveBenchmarkConfig(
  configPathArg: string,
  databasePathArg?: string,
): Promise<EffectiveConfigLoadResult> {
  const configPath = resolve(configPathArg)
  const bootstrap = initConfig(configPath)
  const bootstrapWithAuth: GatewayConfig = {
    ...bootstrap,
    auth: {
      ...bootstrap.auth,
      staticKeys: defaultTestStaticKeys,
    },
  }
  setConfig(bootstrapWithAuth)
  const databasePath = resolve(databasePathArg ?? process.env['DATABASE_PATH'] ?? './data/gateway.db')

  if (!existsSync(databasePath)) {
    return {
      config: bootstrapWithAuth,
      configPath,
      source: 'bootstrap_file',
    }
  }

  const sqlite = openStandaloneSqlite(databasePath)
  try {
    const repo = new SqliteConfigRepository(sqlite.db)
    const persisted = await repo.getActive()
    if (!persisted) {
      return {
        config: bootstrapWithAuth,
        configPath,
        databasePath,
        source: 'bootstrap_file',
      }
    }

    const versionRow = sqlite.db
      .select({ version: configVersions.version })
      .from(configVersions)
      .where(eq(configVersions.isActive, 1))
      .limit(1)
      .all()

    return {
      config: mergeWithAdminConfig({ auth: bootstrapWithAuth.auth }, {
        ...persisted,
        auth: {
          ...persisted.auth,
          staticKeys: persisted.auth.staticKeys ?? defaultTestStaticKeys,
        },
      }),
      configPath,
      databasePath,
      source: 'sqlite_active',
      activeVersion: Number(versionRow[0]?.version ?? 0) || undefined,
    }
  } finally {
    sqlite.close()
  }
}
