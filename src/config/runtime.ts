import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setConfig } from './index.js'
import type { GatewayConfig, BootstrapConfig, AdminConfig } from './loader.js'
import { createDefaultAdminConfig, mergeWithAdminConfig, toAdminConfig } from './loader.js'
import type { IConfigRepository, ConfigVersionMeta } from '../repositories/config/interface.js'
import type { DownstreamRegistry } from '../registry/registry.js'
import type { RateLimiter } from '../resilience/rateLimiter.js'

interface RuntimeConfigManagerOptions {
  bootstrap: BootstrapConfig
  initial: GatewayConfig
  registry: DownstreamRegistry
  rateLimiter?: RateLimiter
  configRepo?: IConfigRepository
  configPath?: string
}

export class RuntimeConfigManager {
  private bootstrap: BootstrapConfig
  private effective: GatewayConfig
  private fileVersion = 0
  private readonly configPath: string

  constructor(private readonly options: RuntimeConfigManagerOptions) {
    this.bootstrap = options.bootstrap
    this.effective = options.initial
    this.configPath = options.configPath ?? process.env['CONFIG_PATH'] ?? './config'
    setConfig(options.initial)
  }

  getBootstrap(): BootstrapConfig {
    return this.bootstrap
  }

  getEffective(): GatewayConfig {
    return this.effective
  }

  getAdminConfig(): AdminConfig {
    return toAdminConfig(this.effective)
  }

  private persistGatewayJson(config: GatewayConfig): void {
    const filePath = join(this.configPath, 'bootstrap.json')
    const tempPath = join(this.configPath, `bootstrap.json.${process.pid}.tmp`)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
    renameSync(tempPath, filePath)
  }

  async initialize(): Promise<void> {
    if (!this.options.configRepo) {
      await this.applyResolvedConfig(this.effective, false)
      return
    }

    const persisted = await this.options.configRepo.getActive()
    if (persisted) {
      await this.applyResolvedConfig(mergeWithAdminConfig(this.bootstrap, persisted), false)
      return
    }

    await this.options.configRepo.save(this.getAdminConfig(), {
      source: 'file_bootstrap',
      createdBy: 'system',
      comment: 'Initial bootstrap from bootstrap.json',
    })

    await this.applyResolvedConfig(this.effective, false)
  }

  async saveAdminConfig(config: AdminConfig, meta: ConfigVersionMeta): Promise<number> {
    if (this.options.configRepo) {
      const version = await this.options.configRepo.save(config, meta)
      await this.applyResolvedConfig(mergeWithAdminConfig(this.bootstrap, config))
      return version
    }

    const resolved = mergeWithAdminConfig(this.bootstrap, config)
    try {
      this.persistGatewayJson(resolved)
    } catch (err) {
      throw new Error(
        `Config persistence requires a writable ${join(this.configPath, 'bootstrap.json')}: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    await this.applyResolvedConfig(resolved)
    this.fileVersion += 1
    return this.fileVersion
  }

  async rollback(version: number): Promise<void> {
    if (!this.options.configRepo) {
      throw new Error('Config rollback requires the SQLite config repository')
    }

    await this.options.configRepo.rollback(version)
    const persisted = await this.options.configRepo.getActive()
    const admin = persisted ?? createDefaultAdminConfig()
    await this.applyResolvedConfig(mergeWithAdminConfig(this.bootstrap, admin))
  }

  async applyResolvedConfig(config: GatewayConfig, restartRegistry: boolean = true): Promise<void> {
    this.effective = config
    setConfig(config)
    this.options.rateLimiter?.updateConfig(config.resilience.rateLimit)

    if (restartRegistry) {
      this.options.registry.stop()
      await this.options.registry.start(config.servers, config.resilience)
      return
    }

    await this.options.registry.start(config.servers, config.resilience)
  }
}
