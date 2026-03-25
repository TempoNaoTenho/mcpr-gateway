import { describe, expect, it } from 'vitest';
import {
  AUTO_REFRESH_COOLDOWN_MS,
  getAutoRefreshReason,
  getManualAuthKind,
  shouldSkipAutoRefreshCooldown,
} from '../../ui/src/lib/serverAuthFlow.ts';

function makeConfigServer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'docs',
    namespaces: ['default'],
    transport: 'streamable-http',
    enabled: true,
    trustLevel: 'verified',
    auth: { mode: 'none' },
    ...overrides,
  } as any;
}

function makeRuntimeServer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'docs',
    namespaces: ['default'],
    transport: 'streamable-http',
    enabled: true,
    trustLevel: 'verified',
    health: 'unknown',
    toolCount: 0,
    schemaTokens: 0,
    totalTokens: 0,
    customizedTools: 0,
    ...overrides,
  } as any;
}

describe('serverAuthFlow', () => {
  it('marks interactive stdio servers as manually authenticated until ready', () => {
    const configServer = makeConfigServer({
      transport: 'stdio',
      auth: undefined,
      stdioInteractiveAuth: { enabled: true },
    });

    expect(getManualAuthKind(configServer, makeRuntimeServer({
      transport: 'stdio',
      interactiveAuthStatus: 'pending',
    }))).toBe('stdio');

    expect(getManualAuthKind(configServer, makeRuntimeServer({
      transport: 'stdio',
      interactiveAuthStatus: 'ready',
    }))).toBeNull();
  });

  it('auto-refreshes plain stdio when periodic catalog refresh is configured', () => {
    const configServer = makeConfigServer({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'srv'],
      discovery: { mode: 'auto' },
      refreshIntervalSeconds: 300,
      stdioInteractiveAuth: { enabled: false },
    });

    expect(
      getAutoRefreshReason(
        configServer,
        makeRuntimeServer({ transport: 'stdio', toolCount: 0 }),
      ),
    ).toBe('stdio-empty-catalog:auto:ok');

    const manual = makeConfigServer({
      transport: 'stdio',
      command: 'npx',
      args: [],
      discovery: { mode: 'manual' },
      refreshIntervalSeconds: undefined,
      stdioInteractiveAuth: { enabled: false },
    });

    expect(
      getAutoRefreshReason(manual, makeRuntimeServer({ transport: 'stdio', toolCount: 0 })),
    ).toBeNull();
  });

  it('only auto-refreshes interactive stdio after auth is ready', () => {
    const configServer = makeConfigServer({
      transport: 'stdio',
      auth: undefined,
      stdioInteractiveAuth: { enabled: true },
    });

    expect(getAutoRefreshReason(configServer, makeRuntimeServer({
      transport: 'stdio',
      interactiveAuthStatus: 'pending',
    }))).toBeNull();

    expect(getAutoRefreshReason(configServer, makeRuntimeServer({
      transport: 'stdio',
      interactiveAuthStatus: 'ready',
    }))).toBe('stdio-ready');
  });

  it('keeps OAuth auth actions visible before and after authorization', () => {
    const configServer = makeConfigServer({
      auth: { mode: 'oauth' },
    });

    expect(getManualAuthKind(configServer, makeRuntimeServer({
      authStatus: 'configured',
    }))).toBe('oauth');

    expect(getManualAuthKind(configServer, makeRuntimeServer({
      authStatus: 'authorized',
    }))).toBe('oauth');

    expect(getAutoRefreshReason(configServer, makeRuntimeServer({
      authStatus: 'configured',
    }))).toBeNull();

    expect(getAutoRefreshReason(configServer, makeRuntimeServer({
      authStatus: 'authorized',
    }))).toBe('http-empty-catalog:oauth');
  });

  it('detects OAuth servers from the runtime authorization server even when config auth is generic', () => {
    const configServer = makeConfigServer({
      auth: { mode: 'none' },
    });

    expect(getManualAuthKind(configServer, makeRuntimeServer({
      authStatus: 'auth_required',
      authAuthorizationServer: 'https://issuer.example.com',
    }))).toBe('oauth');

    expect(getAutoRefreshReason(configServer, makeRuntimeServer({
      authStatus: 'configured',
      authAuthorizationServer: 'https://issuer.example.com',
    }))).toBeNull();

    expect(getAutoRefreshReason(configServer, makeRuntimeServer({
      authStatus: 'authorized',
      authAuthorizationServer: 'https://issuer.example.com',
    }))).toBe('http-empty-catalog:oauth');
  });

  it('treats managed bearer servers as manual until a secret exists', () => {
    const configServer = makeConfigServer({
      auth: {
        mode: 'bearer',
        source: { type: 'secret' },
      },
    });

    expect(getManualAuthKind(configServer, makeRuntimeServer({
      authStatus: 'auth_required',
      managedSecretConfigured: false,
    }))).toBe('managed_bearer');

    expect(getManualAuthKind(configServer, makeRuntimeServer({
      authStatus: 'configured',
      managedSecretConfigured: true,
    }))).toBeNull();

    expect(getAutoRefreshReason(configServer, makeRuntimeServer({
      authStatus: 'configured',
      managedSecretConfigured: true,
    }))).toBe('http-empty-catalog:managed:ok');
  });

  it('applies cooldown between auto-refresh attempts for the same logical reason', () => {
    const t0 = 1_000_000;
    const entry = { logicalReason: 'http-empty-catalog:oauth', lastAttemptAt: t0 };
    expect(shouldSkipAutoRefreshCooldown(entry, 'http-empty-catalog:oauth', t0 + AUTO_REFRESH_COOLDOWN_MS - 1)).toBe(
      true,
    );
    expect(shouldSkipAutoRefreshCooldown(entry, 'http-empty-catalog:oauth', t0 + AUTO_REFRESH_COOLDOWN_MS)).toBe(
      false,
    );
  });

  it('does not skip auto-refresh when the logical reason changes', () => {
    const entry = { logicalReason: 'stdio-ready', lastAttemptAt: Date.now() };
    expect(shouldSkipAutoRefreshCooldown(entry, 'http-empty-catalog:oauth')).toBe(false);
  });

  it('auto-refreshes env-backed HTTP servers without surfacing manual auth', () => {
    const configServer = makeConfigServer({
      auth: {
        mode: 'bearer',
        source: { type: 'env', envVar: 'MCP_SERVER_TOKEN' },
      },
    });

    expect(getManualAuthKind(configServer, makeRuntimeServer({
      authStatus: 'configured',
    }))).toBeNull();

    expect(getAutoRefreshReason(configServer, makeRuntimeServer({
      authStatus: 'configured',
    }))).toBe('http-empty-catalog:auto:configured:ok');
  });
});
