import type { AdminConfig } from '../../config/loader.js'

export interface ConfigVersionMeta {
  source: 'file_bootstrap' | 'ui_edit' | 'api_import'
  createdBy: string
  comment?: string
}

export interface ConfigVersionSummary {
  id: number
  version: number
  source: string
  createdBy: string
  createdAt: Date
  comment?: string
  isActive: boolean
}

export interface IConfigRepository {
  getActive(): Promise<AdminConfig | undefined>
  save(config: AdminConfig, meta: ConfigVersionMeta): Promise<number>
  listVersions(): Promise<ConfigVersionSummary[]>
  rollback(version: number): Promise<void>
}
