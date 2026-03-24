import { loadConfig, normalizeGatewayConfig } from './loader.js'
import type { GatewayConfig } from './loader.js'

export type { GatewayConfig }
export { loadConfig }

let _config: GatewayConfig | undefined

export function getConfig(): GatewayConfig {
  if (!_config) throw new Error('Config not loaded — call initConfig() first')
  return _config
}

export function initConfig(configPath?: string): GatewayConfig {
  _config = loadConfig(configPath)
  return _config
}

export function setConfig(config: GatewayConfig): void {
  _config = normalizeGatewayConfig(config)
}
