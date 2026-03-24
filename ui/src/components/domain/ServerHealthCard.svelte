<script lang="ts">
  import { RefreshCw } from 'lucide-svelte';
  import Badge from '$components/ui/Badge.svelte';
  import InfoTooltip from '$components/ui/InfoTooltip.svelte';
  import Switch from '$components/ui/Switch.svelte';
  import type { ConfigServer, ServerInfo } from '$lib/api.js';
  import { authStatusToBadgeVariant } from '$lib/authStatusBadge.js';
  import { getManualAuthKind } from '$lib/serverAuthFlow.js';

  interface Props {
    server: ServerInfo;
    configServer?: ConfigServer;
    oauthStorageEnabled?: boolean;
    interactiveBusy?: boolean;
    hasActiveStdioInteractiveAuth?: boolean;
    onRefresh?: (id: string) => void;
    onInspect?: (id: string) => void;
    refreshing?: boolean;
    onEnabledToggle?: (enabled: boolean) => void;
    togglingEnabled?: boolean;
    onConnectOAuth?: (id: string) => void;
    onAuthenticateStdio?: (id: string) => void;
    onCancelStdioAuth?: (id: string) => void;
    onConfigureManagedBearer?: (id: string) => void;
  }

  let {
    server,
    configServer,
    oauthStorageEnabled = false,
    interactiveBusy = false,
    hasActiveStdioInteractiveAuth = false,
    onRefresh,
    onInspect,
    refreshing = false,
    onEnabledToggle,
    togglingEnabled = false,
    onConnectOAuth,
    onAuthenticateStdio,
    onCancelStdioAuth,
    onConfigureManagedBearer,
  }: Props = $props();

  const manualAuthForEmptyCatalog = $derived(
    configServer && server.enabled && server.toolCount === 0
      ? getManualAuthKind(configServer, server)
      : null,
  );

  const healthVariant = {
    healthy: 'success' as const,
    degraded: 'warning' as const,
    offline: 'danger' as const,
    unknown: 'muted' as const,
  };

  const interactiveVariant = {
    starting: 'warning' as const,
    pending: 'warning' as const,
    ready: 'success' as const,
    failed: 'danger' as const,
    expired: 'danger' as const,
    cancelled: 'muted' as const,
  };

</script>

<div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-4">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2 flex-wrap">
        <p class="font-medium text-slate-900 dark:text-white text-sm truncate">{server.id}</p>
        <Badge variant={healthVariant[server.health as keyof typeof healthVariant] ?? 'muted'}>
          {server.health}
        </Badge>
        {#if server.transport !== 'stdio' && server.authStatus}
          <Badge variant={authStatusToBadgeVariant(server.authStatus)}>
            auth {server.authStatus}
          </Badge>
        {/if}
        {#if server.interactiveAuthStatus}
          <Badge variant={interactiveVariant[server.interactiveAuthStatus as keyof typeof interactiveVariant] ?? 'muted'}>
            stdio auth {server.interactiveAuthStatus}
          </Badge>
        {/if}
        {#if !server.enabled}
          <Badge variant="muted">disabled</Badge>
        {/if}
      </div>
      <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
        {server.namespaces.join(', ')} · {server.transport}
        {#if server.url}· {server.url}{/if}
      </p>
      <div class="flex items-center gap-4 mt-2 text-xs text-slate-500 dark:text-slate-400">
        <span>{server.toolCount} tools</span>
        <span>~{server.totalTokens} ctx tokens</span>
        {#if server.customizedTools > 0}
          <span>{server.customizedTools} customized</span>
        {/if}
        {#if server.latencyMs !== undefined}
          <span>{server.latencyMs}ms</span>
        {/if}
        {#if server.error}
          <span class="text-red-500 truncate max-w-48">{server.error}</span>
        {/if}
        {#if server.transport !== 'stdio' && server.authMessage}
          <span class="text-amber-600 dark:text-amber-300 truncate max-w-48">{server.authMessage}</span>
        {/if}
        {#if server.interactiveAuthMessage}
          <span class="{server.interactiveAuthStatus === 'failed' || server.interactiveAuthStatus === 'expired' ? 'text-red-500' : 'text-amber-600 dark:text-amber-300'} truncate max-w-48">
            {server.interactiveAuthMessage}
          </span>
        {/if}
      </div>
      {#if manualAuthForEmptyCatalog}
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <span class="text-xs font-medium text-slate-600 dark:text-slate-400 inline-flex items-center gap-1">
            Auth
            <InfoTooltip text="Downstream servers may return an empty tool list until authentication completes or the catalog is refreshed." />
          </span>
          {#if manualAuthForEmptyCatalog === 'stdio' && onAuthenticateStdio}
            <button
              type="button"
              onclick={() => onAuthenticateStdio!(server.id)}
              disabled={interactiveBusy || hasActiveStdioInteractiveAuth}
              class="px-2 py-1 text-xs rounded-lg border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 disabled:opacity-50"
            >
              Authenticate
            </button>
            {#if hasActiveStdioInteractiveAuth && onCancelStdioAuth}
              <button
                type="button"
                onclick={() => onCancelStdioAuth!(server.id)}
                disabled={interactiveBusy}
                class="px-2 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 disabled:opacity-50"
              >
                Cancel auth
              </button>
            {/if}
          {/if}
          {#if manualAuthForEmptyCatalog === 'oauth' && onConnectOAuth}
            <button
              type="button"
              onclick={() => onConnectOAuth!(server.id)}
              disabled={!oauthStorageEnabled}
              class="px-2 py-1 text-xs rounded-lg border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 disabled:opacity-50"
            >
              Connect OAuth
            </button>
          {/if}
          {#if manualAuthForEmptyCatalog === 'managed_bearer' && onConfigureManagedBearer}
            <button
              type="button"
              onclick={() => onConfigureManagedBearer!(server.id)}
              class="px-2 py-1 text-xs rounded-lg border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300"
            >
              Configure token
            </button>
          {/if}
        </div>
      {/if}
    </div>
    <div class="flex flex-col items-end gap-2 shrink-0">
      {#if onEnabledToggle}
        <div class="flex items-center gap-1.5">
          <span class="text-xs font-medium text-slate-600 dark:text-slate-400">Enabled</span>
          <InfoTooltip text="When off, this server is excluded from the MCP tool pipeline and routing until turned back on." />
          <Switch
            checked={server.enabled}
            ariaLabel={`Toggle server ${server.id} enabled`}
            disabled={togglingEnabled}
            onchange={onEnabledToggle}
          />
        </div>
      {/if}
      <div class="flex items-center gap-1">
        {#if onInspect}
          <button
            onclick={() => onInspect!(server.id)}
            class="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          >
            View schema
          </button>
        {/if}
        {#if onRefresh}
          <button
            onclick={() => onRefresh!(server.id)}
            disabled={refreshing}
            class="p-2 rounded-lg text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950 transition-colors disabled:opacity-40"
            aria-label="Refresh server tools"
          >
            <RefreshCw size={14} class={refreshing ? 'animate-spin' : ''} />
          </button>
        {/if}
      </div>
    </div>
  </div>
</div>
