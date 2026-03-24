import { toolCandidateKey } from '../candidate/lexical.js'
import type { GatewayConfig } from './loader.js'

export function disabledToolKeysForNamespace(
  config: GatewayConfig,
  namespace: string,
): ReadonlySet<string> {
  const refs = config.namespaces[namespace]?.disabledTools
  if (!refs?.length) return new Set()
  return new Set(refs.map((r) => toolCandidateKey(r.serverId, r.name)))
}

export function isToolDisabledForNamespace(
  config: GatewayConfig,
  namespace: string,
  serverId: string,
  toolName: string,
): boolean {
  return disabledToolKeysForNamespace(config, namespace).has(toolCandidateKey(serverId, toolName))
}
