import type { ConfigServer, ServerInfo } from './api.js';

export type ManualAuthKind = 'stdio' | 'oauth' | 'managed_bearer';

function isManagedBearerServer(configServer: ConfigServer | undefined): boolean {
  return configServer?.auth?.mode === 'bearer' && configServer.auth.source?.type === 'secret';
}

function isInteractiveStdioServer(configServer: ConfigServer | undefined): boolean {
  return configServer?.transport === 'stdio' && configServer.stdioInteractiveAuth?.enabled === true;
}

export function getManualAuthKind(
  configServer: ConfigServer | undefined,
  runtimeServer?: ServerInfo | null,
): ManualAuthKind | null {
  if (!configServer) return null;

  if (isInteractiveStdioServer(configServer)) {
    return runtimeServer?.interactiveAuthStatus === 'ready' ? null : 'stdio';
  }

  if (configServer.auth?.mode === 'oauth') {
    return runtimeServer?.authStatus === 'authorized' ? null : 'oauth';
  }

  if (isManagedBearerServer(configServer)) {
    return runtimeServer?.managedSecretConfigured === true && runtimeServer?.authStatus !== 'auth_required'
      ? null
      : 'managed_bearer';
  }

  return null;
}

function isBlockedHttpRefresh(runtimeServer: ServerInfo | null | undefined): boolean {
  return runtimeServer?.authStatus === 'auth_required' || runtimeServer?.authStatus === 'misconfigured';
}

export function getAutoRefreshReason(
  configServer: ConfigServer | undefined,
  runtimeServer?: ServerInfo | null,
): string | null {
  if (!configServer || !runtimeServer || !configServer.enabled || !runtimeServer.enabled) {
    return null;
  }

  if (runtimeServer.toolCount > 0) {
    return null;
  }

  if (isInteractiveStdioServer(configServer)) {
    return runtimeServer.interactiveAuthStatus === 'ready' ? 'stdio-ready' : null;
  }

  if (configServer.transport === 'stdio') {
    return null;
  }

  if (configServer.auth?.mode === 'oauth') {
    return runtimeServer.authStatus === 'authorized' ? 'http-empty-catalog:oauth' : null;
  }

  if (isManagedBearerServer(configServer)) {
    if (runtimeServer.managedSecretConfigured !== true || isBlockedHttpRefresh(runtimeServer)) {
      return null;
    }
    return `http-empty-catalog:managed:${runtimeServer.error ? 'error' : 'ok'}`;
  }

  if (isBlockedHttpRefresh(runtimeServer)) {
    return null;
  }

  return `http-empty-catalog:auto:${runtimeServer.authStatus ?? 'none'}:${runtimeServer.error ? 'error' : 'ok'}`;
}

/** Minimum gap between automatic catalog refresh attempts for the same logical reason (per server). */
export const AUTO_REFRESH_COOLDOWN_MS = 5000;

export type AutoRefreshCooldownEntry = {
  logicalReason: string;
  lastAttemptAt: number;
};

/**
 * When the logical refresh reason is unchanged, wait for the cooldown so we retry empty catalogs
 * without hammering downstream, but do not get stuck after a single failed attempt.
 */
export function shouldSkipAutoRefreshCooldown(
  entry: AutoRefreshCooldownEntry | undefined,
  reason: string,
  nowMs: number = Date.now(),
): boolean {
  if (!entry) return false;
  if (entry.logicalReason !== reason) return false;
  return nowMs - entry.lastAttemptAt < AUTO_REFRESH_COOLDOWN_MS;
}
