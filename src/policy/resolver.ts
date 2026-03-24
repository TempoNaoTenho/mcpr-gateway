import { GatewayErrorCode } from '../types/errors.js'
import type { UserIdentity } from '../types/identity.js'
import type { Mode } from '../types/enums.js'
import type { GatewayConfig } from '../config/loader.js'

export interface PolicyDecision {
  allowed: boolean
  rejectionCode?: GatewayErrorCode
  starterPackKey?: string
  namespacePolicy?: GatewayConfig['namespaces'][string]
}

export function resolvePolicy(
  identity: UserIdentity,
  namespace: string,
  mode: Mode,
  config: GatewayConfig,
): PolicyDecision {
  const deny = (code: GatewayErrorCode): PolicyDecision => ({ allowed: false, rejectionCode: code })

  const namespacePolicy = config.namespaces[namespace]
  if (!namespacePolicy) {
    return deny(GatewayErrorCode.UNAUTHORIZED_NAMESPACE)
  }

  const hasRole = identity.roles.some((r) => namespacePolicy.allowedRoles.includes(r))
  if (!hasRole) {
    return deny(GatewayErrorCode.UNAUTHORIZED_NAMESPACE)
  }

  const hasAllowedNamespace = identity.roles.some((role) => {
    const rolePolicy = config.roles[role]
    return rolePolicy?.allowNamespaces.includes(namespace) ?? false
  })
  if (!hasAllowedNamespace) {
    return deny(GatewayErrorCode.UNAUTHORIZED_NAMESPACE)
  }

  if (!namespacePolicy.allowedModes.includes(mode)) {
    return deny(GatewayErrorCode.UNAUTHORIZED_NAMESPACE)
  }

  for (const role of identity.roles) {
    const rolePolicy = config.roles[role]
    if (rolePolicy?.denyModes?.includes(mode)) {
      return deny(GatewayErrorCode.UNAUTHORIZED_NAMESPACE)
    }
  }

  return {
    allowed: true,
    starterPackKey: namespace,
    namespacePolicy,
  }
}
