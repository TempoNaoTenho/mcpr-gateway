<script lang="ts">
  import { onMount } from 'svelte';
  import {
    ApiError,
    getServers,
    refreshServer,
    startStdioInteractiveAuth,
    cancelStdioInteractiveAuth,
    getConfigServers,
    getPolicies,
    getServerSchema,
    createConfigServer,
    updateConfigServer,
    deleteConfigServer,
    previewConfigServerImport,
    importConfigServers,
    getDownstreamAuthCapabilities,
    setDownstreamBearerSecret,
    startDownstreamOAuth,
    disconnectDownstreamAuth,
    type ServerInfo,
    type ConfigServer,
    type ConfigServerAuth,
    type ConfigServerImportPreview,
    type ConfigServerImportPayload,
    type ServerSchemaDetail,
  } from '$lib/api.js';
  import { notifications } from '$lib/stores/notifications.js';
  import ServerHealthCard from '../../components/domain/ServerHealthCard.svelte';
  import JsonSchemaEditor from '../../components/domain/JsonSchemaEditor.svelte';
  import ServerSchemaDrawer from '../../components/domain/ServerSchemaDrawer.svelte';
  import Modal from '../../components/ui/Modal.svelte';
  import MultiNamespaceSelect from '../../components/ui/MultiNamespaceSelect.svelte';
  import NamespaceTagSelect from '../../components/ui/NamespaceTagSelect.svelte';
  import InfoTooltip from '../../components/ui/InfoTooltip.svelte';
  import Switch from '../../components/ui/Switch.svelte';
  import Badge from '../../components/ui/Badge.svelte';
  import { authStatusToBadgeVariant } from '$lib/authStatusBadge.js';
  import {
    getAutoRefreshReason,
    getManualAuthKind,
    shouldSkipAutoRefreshCooldown,
    type AutoRefreshCooldownEntry,
  } from '$lib/serverAuthFlow.js';
  import { formatMcpImportForEditor, parseMcpImportText } from '$gatewayLib/mcp-import-parse';

  const emptyServer = (ns = ''): ConfigServer => ({
    id: '',
    namespaces: [ns || 'default'],
    transport: 'streamable-http',
    url: '',
    command: '',
    args: [],
    env: {},
    stdioTimeoutSeconds: 15,
    stdioInteractiveAuth: { enabled: false },
    headers: {},
    auth: { mode: 'none' },
    enabled: true,
    trustLevel: 'verified',
    refreshIntervalSeconds: 300,
    healthcheck: { enabled: true, intervalSeconds: 30 },
    discovery: { mode: 'manual' },
  });

  let servers = $state<ServerInfo[]>([]);
  let configServers = $state<ConfigServer[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let refreshing = $state<Record<string, boolean>>({});
  let interactiveBusy = $state<Record<string, boolean>>({});
  let togglingEnabled = $state<Record<string, boolean>>({});
  let formOpen = $state(false);
  let deleteTarget = $state<ConfigServer | null>(null);
  let rawServerTarget = $state<ConfigServer | null>(null);
  let editingId = $state<string | null>(null);
  let formMode = $state<'manual' | 'import'>('manual');
  let form = $state(emptyServer());
  let argsText = $state('');
  let envText = $state('');
  let headersText = $state('');
  let bearerEnvVar = $state('');
  let managedBearerSecret = $state('');
  let oauthAuthorizationServer = $state('');
  let oauthScopesText = $state('');
  let oauthClientId = $state('');
  let oauthRegistrationMode = $state<'dynamic' | 'static'>('dynamic');
  let healthcheckEnabled = $state(true);
  let discoveryAuto = $state(false);
  let knownNamespaces = $state<string[]>([]);
  let selectedForMove = $state<string[]>([]);
  let bulkMoveNamespace = $state('');
  let bulkMoving = $state(false);
  let importJsonText = $state('');
  let importDefaultNamespace = $state('');
  let importPreview = $state<ConfigServerImportPreview | null>(null);
  let importPreviewLoading = $state(false);
  let importClientError = $state('');
  let serverSchemaDetail = $state<ServerSchemaDetail | null>(null);
  let downstreamAuthCapabilities = $state({
    managedSecretsEnabled: false,
    oauthStorageEnabled: false,
  });
  const interactiveStatusVariant: Record<string, 'warning' | 'success' | 'danger' | 'muted'> = {
    starting: 'warning',
    pending: 'warning',
    ready: 'success',
    failed: 'danger',
    expired: 'danger',
    cancelled: 'muted',
  };

  function hasActiveInteractiveAuth(server: ServerInfo): boolean {
    return server.interactiveAuthStatus === 'starting' || server.interactiveAuthStatus === 'pending';
  }

  function supportsInteractiveAuth(server: ConfigServer): boolean {
    return server.transport === 'stdio' && server.stdioInteractiveAuth?.enabled === true;
  }

  const autoRefreshCooldown = new Map<string, AutoRefreshCooldownEntry>();

  function resetAutoRefreshAttempt(id: string) {
    autoRefreshCooldown.delete(id);
  }

  function getConfigServerById(id: string): ConfigServer | undefined {
    return configServers.find((server) => server.id === id);
  }

  function getPendingAutoRefresh(runtimeServers: ServerInfo[] = servers) {
    const candidates: Array<{ id: string; reason: string }> = [];
    const activeIds = new Set(runtimeServers.map((server) => server.id));

    for (const id of [...autoRefreshCooldown.keys()]) {
      if (!activeIds.has(id)) {
        autoRefreshCooldown.delete(id);
      }
    }

    for (const runtimeServer of runtimeServers) {
      const reason = getAutoRefreshReason(getConfigServerById(runtimeServer.id), runtimeServer);
      if (!reason) {
        autoRefreshCooldown.delete(runtimeServer.id);
        continue;
      }
      if (
        shouldSkipAutoRefreshCooldown(autoRefreshCooldown.get(runtimeServer.id), reason)
        || refreshing[runtimeServer.id]
      ) {
        continue;
      }
      candidates.push({ id: runtimeServer.id, reason });
    }

    return candidates;
  }

  function mergeRuntimeServer(id: string, patch: Partial<ServerInfo>) {
    servers = servers.map((server) => (
      server.id === id
        ? {
            ...server,
            ...patch,
          }
        : server
    ));
  }

  function mergeConfigServer(id: string, patch: Partial<ConfigServer>) {
    configServers = configServers.map((server) => (
      server.id === id ? { ...server, ...patch } : server
    ));
  }

  async function toggleServerEnabled(id: string, enabled: boolean) {
    togglingEnabled = { ...togglingEnabled, [id]: true };
    const prevCfg = configServers.find((s) => s.id === id);
    const prevEnabled = prevCfg?.enabled ?? servers.find((s) => s.id === id)?.enabled;
    mergeConfigServer(id, { enabled });
    mergeRuntimeServer(id, { enabled });
    try {
      await updateConfigServer(id, { enabled });
    } catch {
      if (prevCfg && typeof prevEnabled === 'boolean') {
        mergeConfigServer(id, { enabled: prevEnabled });
        mergeRuntimeServer(id, { enabled: prevEnabled });
      }
      notifications.error('Failed to update server enabled state');
    } finally {
      const next = { ...togglingEnabled };
      delete next[id];
      togglingEnabled = next;
    }
  }

  async function load() {
    loading = true;
    try {
      const [runtime, persisted, policies, authCapabilities] = await Promise.all([
        getServers(),
        getConfigServers(),
        getPolicies(),
        getDownstreamAuthCapabilities(),
      ]);
      downstreamAuthCapabilities = authCapabilities;
      servers = runtime.servers;
      configServers = persisted.servers;
      knownNamespaces = Object.keys(policies.namespaces).sort();
    } catch {
      notifications.error('Failed to load servers');
    } finally {
      loading = false;
    }
  }

  async function runAutoRefresh(runtimeServers: ServerInfo[] = servers) {
    const candidates = getPendingAutoRefresh(runtimeServers);
    if (candidates.length === 0) return;

    const now = Date.now();
    for (const candidate of candidates) {
      autoRefreshCooldown.set(candidate.id, { logicalReason: candidate.reason, lastAttemptAt: now });
    }

    await Promise.all(candidates.map(({ id }) => handleRefresh(id, { silent: true })));
  }

  function getPreferredNamespace(): string {
    if (knownNamespaces.includes('default')) return 'default';
    return knownNamespaces[0] ?? 'default';
  }

  function openCreate() {
    editingId = null;
    formMode = 'manual';
    form = emptyServer(getPreferredNamespace());
    argsText = '';
    envText = '';
    headersText = '';
    bearerEnvVar = '';
    managedBearerSecret = '';
    oauthAuthorizationServer = '';
    oauthScopesText = '';
    oauthClientId = '';
    oauthRegistrationMode = 'dynamic';
    healthcheckEnabled = true;
    discoveryAuto = false;
    importJsonText = '';
    importDefaultNamespace = getPreferredNamespace();
    importPreview = null;
    importClientError = '';
    formOpen = true;
  }

  function openEdit(server: ConfigServer) {
    editingId = server.id;
    formMode = 'manual';
    form = {
      ...server,
      args: server.args ?? [],
      env: server.env ?? {},
      stdioTimeoutSeconds: server.stdioTimeoutSeconds ?? 15,
      stdioInteractiveAuth: server.stdioInteractiveAuth ?? { enabled: false },
      headers: server.headers ?? {},
      auth: server.auth ?? { mode: 'none' },
      healthcheck: server.healthcheck ?? { enabled: true, intervalSeconds: 30 },
      discovery: server.discovery ?? { mode: 'manual' },
    };
    argsText = (server.args ?? []).join(', ');
    envText = Object.entries(server.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    headersText = Object.entries(server.headers ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    bearerEnvVar =
      server.auth?.mode === 'bearer' && server.auth.source?.type === 'env' ? server.auth.source.envVar : '';
    managedBearerSecret = '';
    oauthAuthorizationServer = server.auth?.mode === 'oauth' ? server.auth.authorizationServer ?? '' : '';
    oauthScopesText = server.auth?.mode === 'oauth' ? (server.auth.scopes ?? []).join(', ') : '';
    oauthClientId = server.auth?.mode === 'oauth' && server.auth.registration?.mode === 'static'
      ? server.auth.registration.clientId
      : '';
    oauthRegistrationMode = server.auth?.mode === 'oauth' && server.auth.registration?.mode === 'static'
      ? 'static'
      : 'dynamic';
    healthcheckEnabled = form.healthcheck?.enabled ?? true;
    discoveryAuto = form.discovery?.mode === 'auto';
    formOpen = true;
  }

  function parseKeyValueText(text: string): Record<string, string> {
    const entries = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf('=');
        return idx === -1 ? [line, ''] : [line.slice(0, idx), line.slice(idx + 1)];
      });
    return Object.fromEntries(entries);
  }

  function formatServerJson(server: ConfigServer | null): string {
    if (!server) return '';
    return JSON.stringify(server, null, 2);
  }

  function buildServerAuth(): ConfigServerAuth | undefined {
    if (form.transport === 'stdio') return undefined;
    if (!form.auth || form.auth.mode === 'none') return { mode: 'none' };
    if (form.auth.mode === 'bearer') {
      if (form.auth.source?.type === 'secret') {
        return {
          mode: 'bearer',
          source: { type: 'secret' },
        };
      }
      if (form.auth.source?.type === 'env') {
        return {
          mode: 'bearer',
          source: { type: 'env', envVar: bearerEnvVar.trim() },
        };
      }
      return {
        mode: 'bearer',
        source: { type: 'env', envVar: bearerEnvVar.trim() },
      };
    }
    return {
      mode: 'oauth',
      authorizationServer: oauthAuthorizationServer.trim() || undefined,
      scopes: oauthScopesText
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
      registration: oauthRegistrationMode === 'static'
        ? { mode: 'static', clientId: oauthClientId.trim() }
        : { mode: 'dynamic' },
    };
  }

  function resetImportPreview() {
    importPreview = null;
    importClientError = '';
  }

  function buildImportPayload(): ConfigServerImportPayload {
    const fromText = parseMcpImportText(importJsonText);
    if (!fromText.ok) {
      throw new Error(fromText.message);
    }
    const defaultNamespace =
      importDefaultNamespace.trim() || fromText.defaultNamespace || undefined;
    return {
      mcpServers: fromText.mcpServers,
      defaultNamespace,
    };
  }

  function tryNormalizeImportTextarea(): boolean {
    const coerced = parseMcpImportText(importJsonText);
    if (!coerced.ok) return false;
    importJsonText = formatMcpImportForEditor(coerced.mcpServers);
    if (!importDefaultNamespace.trim() && coerced.defaultNamespace) {
      importDefaultNamespace = coerced.defaultNamespace;
    }
    resetImportPreview();
    return true;
  }

  function formatImportJson() {
    const coerced = parseMcpImportText(importJsonText);
    if (!coerced.ok) {
      importClientError = coerced.message;
      return;
    }
    importJsonText = formatMcpImportForEditor(coerced.mcpServers);
    if (!importDefaultNamespace.trim() && coerced.defaultNamespace) {
      importDefaultNamespace = coerced.defaultNamespace;
    }
    importClientError = '';
    resetImportPreview();
  }

  function handleImportPaste() {
    requestAnimationFrame(() => {
      tryNormalizeImportTextarea();
    });
  }

  async function previewImport() {
    importPreviewLoading = true;
    importClientError = '';
    try {
      importPreview = await previewConfigServerImport(buildImportPayload());
    } catch (err) {
      importPreview = null;
      importClientError = err instanceof Error ? err.message : 'Failed to preview import';
    } finally {
      importPreviewLoading = false;
    }
  }

  async function runImport() {
    saving = true;
    try {
      const payload = buildImportPayload();
      const result = await importConfigServers(payload);
      if (result.runtimeWarnings.length > 0) {
        notifications.error(
          `Imported ${result.imported} server${result.imported === 1 ? '' : 's'} with ${result.runtimeWarnings.length} runtime warning${result.runtimeWarnings.length === 1 ? '' : 's'}`,
        );
      } else {
        notifications.success(`Imported ${result.imported} server${result.imported === 1 ? '' : 's'}`);
      }
      formOpen = false;
      await load();
      for (const serverId of Object.keys(payload.mcpServers)) {
        resetAutoRefreshAttempt(serverId);
      }
      await runAutoRefresh();
    } catch (err) {
      notifications.error(err instanceof Error ? err.message : 'Failed to import servers');
    } finally {
      saving = false;
    }
  }

  async function saveServer() {
    saving = true;
    try {
      const payload: ConfigServer = {
        ...form,
        url: form.transport === 'stdio' ? undefined : form.url || undefined,
        command: form.transport === 'stdio' ? form.command || undefined : undefined,
        args: form.transport === 'stdio'
          ? argsText.split(',').map((part) => part.trim()).filter(Boolean)
          : undefined,
        env: form.transport === 'stdio' ? parseKeyValueText(envText) : undefined,
        stdioTimeoutSeconds: form.transport === 'stdio' ? form.stdioTimeoutSeconds ?? 15 : undefined,
        stdioInteractiveAuth: form.transport === 'stdio'
          ? { enabled: form.stdioInteractiveAuth?.enabled === true }
          : undefined,
        headers: form.transport === 'stdio' ? undefined : parseKeyValueText(headersText),
        auth: buildServerAuth(),
        healthcheck: {
          enabled: healthcheckEnabled,
          intervalSeconds: form.healthcheck?.intervalSeconds ?? 30,
        },
        discovery: {
          mode: discoveryAuto ? 'auto' : 'manual',
        },
      };

      if (payload.auth?.mode === 'bearer' && payload.auth.source?.type === 'secret' && !downstreamAuthCapabilities.managedSecretsEnabled) {
        notifications.error('Managed bearer secrets require DOWNSTREAM_AUTH_ENCRYPTION_KEY and SQLite persistence');
        return;
      }

      if (editingId) {
        await updateConfigServer(editingId, payload);
        if (payload.auth?.mode === 'bearer' && payload.auth.source?.type === 'secret' && managedBearerSecret.trim()) {
          const bearerRes = await setDownstreamBearerSecret(editingId, managedBearerSecret.trim());
          if (bearerRes.refreshError) {
            notifications.warning(`Server ${editingId} updated, but catalog refresh failed: ${bearerRes.refreshError}`);
          } else {
            notifications.success(`Server ${editingId} updated`);
          }
        } else {
          notifications.success(`Server ${editingId} updated`);
        }
      } else {
        await createConfigServer(payload);
        if (payload.auth?.mode === 'bearer' && payload.auth.source?.type === 'secret' && managedBearerSecret.trim()) {
          const bearerRes = await setDownstreamBearerSecret(payload.id, managedBearerSecret.trim());
          if (bearerRes.refreshError) {
            notifications.warning(`Server ${payload.id} created, but catalog refresh failed: ${bearerRes.refreshError}`);
          } else {
            notifications.success(`Server ${payload.id} created`);
          }
        } else {
          notifications.success(`Server ${payload.id} created`);
        }
      }

      formOpen = false;
      await load();
      resetAutoRefreshAttempt(payload.id);
      await runAutoRefresh();
    } catch (err) {
      notifications.error(err instanceof Error ? err.message : 'Failed to save server');
    } finally {
      saving = false;
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    saving = true;
    try {
      await deleteConfigServer(deleteTarget.id);
      notifications.success(`Server ${deleteTarget.id} deleted`);
      resetAutoRefreshAttempt(deleteTarget.id);
      deleteTarget = null;
      await load();
    } catch (err) {
      notifications.error(err instanceof Error ? err.message : 'Failed to delete server');
    } finally {
      saving = false;
    }
  }

  async function moveSelectedServers() {
    if (!bulkMoveNamespace || selectedForMove.length === 0) return;
    bulkMoving = true;
    const movedIds = [...selectedForMove];
    try {
      await Promise.all(
        movedIds.map((id) => {
          const server = configServers.find((s) => s.id === id);
          const current = server?.namespaces ?? [];
          const next = current.includes(bulkMoveNamespace) ? current : [...current, bulkMoveNamespace];
          return updateConfigServer(id, { namespaces: next });
        }),
      );
      const count = movedIds.length;
      notifications.success(`${count} server${count === 1 ? '' : 's'} added to ${bulkMoveNamespace}`);
      selectedForMove = [];
      bulkMoveNamespace = '';
      await load();
      for (const id of movedIds) {
        resetAutoRefreshAttempt(id);
      }
      await runAutoRefresh();
    } catch {
      notifications.error('Failed to add namespace to servers');
    } finally {
      bulkMoving = false;
    }
  }

  async function handleRefresh(id: string, options: { silent?: boolean } = {}) {
    const { silent = false } = options;
    refreshing = { ...refreshing, [id]: true };
    try {
      const res = await refreshServer(id);
      mergeRuntimeServer(id, {
        toolCount: res.toolCount,
        health: res.health,
        lastChecked: res.lastChecked,
        latencyMs: res.latencyMs,
        error: res.error,
        authStatus: res.authStatus,
        authMessage: res.authMessage,
        interactiveAuthStatus: res.interactiveAuthStatus,
        interactiveAuthMessage: res.interactiveAuthMessage,
        interactiveAuthUrl: res.interactiveAuthUrl,
      });
      if (!silent) {
        notifications.success(`${id}: ${res.toolCount} tools refreshed`);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details as Partial<ServerInfo> | undefined;
        if (details) {
          const current = servers.find((server) => server.id === id);
          mergeRuntimeServer(id, {
            toolCount: typeof details.toolCount === 'number' ? details.toolCount : current?.toolCount,
            health: typeof details.health === 'string' ? details.health : current?.health,
            lastChecked: typeof details.lastChecked === 'string' ? details.lastChecked : current?.lastChecked,
            latencyMs: typeof details.latencyMs === 'number' ? details.latencyMs : current?.latencyMs,
            error: typeof details.error === 'string' ? details.error : current?.error,
            authStatus: typeof details.authStatus === 'string' ? details.authStatus : current?.authStatus,
            authMessage: typeof details.authMessage === 'string' ? details.authMessage : current?.authMessage,
            interactiveAuthStatus:
              typeof details.interactiveAuthStatus === 'string'
                ? details.interactiveAuthStatus
                : current?.interactiveAuthStatus,
            interactiveAuthMessage:
              typeof details.interactiveAuthMessage === 'string'
                ? details.interactiveAuthMessage
                : current?.interactiveAuthMessage,
            interactiveAuthUrl:
              typeof details.interactiveAuthUrl === 'string'
                ? details.interactiveAuthUrl
                : current?.interactiveAuthUrl,
          });
        }
      }
      const current = servers.find((server) => server.id === id);
      if (!silent) {
        if (current && hasActiveInteractiveAuth(current)) {
          notifications.warning(current.interactiveAuthMessage ?? `${id}: interactive authentication is in progress`);
        } else {
          notifications.error(err instanceof Error ? err.message : `Failed to refresh ${id}`);
        }
      }
    } finally {
      refreshing = { ...refreshing, [id]: false };
    }
  }

  async function handleAuthenticate(id: string) {
    interactiveBusy = { ...interactiveBusy, [id]: true };
    try {
      const state = await startStdioInteractiveAuth(id);
      mergeRuntimeServer(id, {
        interactiveAuthStatus: state.status,
        interactiveAuthMessage: state.message,
        interactiveAuthUrl: state.url,
      });
      resetAutoRefreshAttempt(id);
      notifications.success(`${id}: authentication session started`);
    } catch (err) {
      notifications.error(err instanceof Error ? err.message : `Failed to start authentication for ${id}`);
    } finally {
      interactiveBusy = { ...interactiveBusy, [id]: false };
    }
  }

  async function handleCancelInteractiveAuth(id: string) {
    interactiveBusy = { ...interactiveBusy, [id]: true };
    try {
      const state = await cancelStdioInteractiveAuth(id);
      mergeRuntimeServer(id, {
        interactiveAuthStatus: state.status,
        interactiveAuthMessage: state.message,
        interactiveAuthUrl: state.url,
      });
      resetAutoRefreshAttempt(id);
      notifications.warning(`${id}: authentication session cancelled`);
    } catch (err) {
      notifications.error(err instanceof Error ? err.message : `Failed to cancel authentication for ${id}`);
    } finally {
      interactiveBusy = { ...interactiveBusy, [id]: false };
    }
  }

  async function pollRuntime() {
    const shouldPoll = servers.some(hasActiveInteractiveAuth) || getPendingAutoRefresh().length > 0;
    if (!shouldPoll) return;
    try {
      const runtime = await getServers();
      servers = runtime.servers;
      await runAutoRefresh(runtime.servers);
    } catch {
      // Avoid noisy polling errors while the operator completes external auth.
    }
  }

  async function openServerSchema(id: string) {
    try {
      serverSchemaDetail = await getServerSchema(id);
    } catch {
      notifications.error(`Failed to load schema for ${id}`);
    }
  }

  async function connectOAuth(id: string) {
    try {
      if (!downstreamAuthCapabilities.oauthStorageEnabled) {
        notifications.error('OAuth downstream auth requires DOWNSTREAM_AUTH_ENCRYPTION_KEY and SQLite persistence');
        return;
      }
      const { authorizeUrl } = await startDownstreamOAuth(id);
      const popup = window.open(authorizeUrl, `downstream-auth-${id}`, 'width=720,height=840');
      if (!popup) {
        notifications.error('Failed to open the OAuth window');
        return;
      }
      const onMessage = async (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === 'downstream-auth:success') {
          window.removeEventListener('message', onMessage);
          const refreshErr = typeof event.data?.refreshError === 'string' ? event.data.refreshError : '';
          if (refreshErr) {
            notifications.warning(`OAuth connected for ${id}, but catalog refresh failed: ${refreshErr}`);
          } else {
            notifications.success(`OAuth connected for ${id}`);
          }
          await load();
          resetAutoRefreshAttempt(id);
          await runAutoRefresh();
        }
        if (event.data?.type === 'downstream-auth:error') {
          window.removeEventListener('message', onMessage);
          notifications.error(event.data?.message ?? `OAuth failed for ${id}`);
        }
      };
      window.addEventListener('message', onMessage);
    } catch (err) {
      notifications.error(err instanceof Error ? err.message : `Failed to start OAuth for ${id}`);
    }
  }

  async function clearDownstreamAuth(id: string) {
    try {
      await disconnectDownstreamAuth(id);
      notifications.success(`Cleared downstream auth for ${id}`);
      resetAutoRefreshAttempt(id);
      await load();
    } catch (err) {
      notifications.error(err instanceof Error ? err.message : `Failed to clear auth for ${id}`);
    }
  }

  onMount(() => {
    void (async () => {
      await load();
      await runAutoRefresh();
    })();
    const timer = window.setInterval(() => {
      void pollRuntime();
    }, 2000);
    return () => window.clearInterval(timer);
  });

  let healthy = $derived(servers.filter((s) => s.health === 'healthy').length);
  let degraded = $derived(servers.filter((s) => s.health === 'degraded').length);
  let offline = $derived(servers.filter((s) => s.health === 'offline').length);
  let importHasBlockingIssues = $derived(
    (importPreview?.conflicts.length ?? 0) > 0 || (importPreview?.validationErrors.length ?? 0) > 0,
  );
</script>

<svelte:head>
  <title>Servers — MCP Gateway</title>
</svelte:head>


<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold text-slate-900 dark:text-white">Servers</h1>
      <p class="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
        {configServers.length} configured · {healthy} healthy · {degraded} degraded · {offline} offline
      </p>
    </div>
    <button
      onclick={openCreate}
      class="px-3 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
    >
      Add MCP Server
    </button>
  </div>

  <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800">
    <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
      <div class="flex items-center gap-2">
        <p class="text-sm font-medium text-slate-700 dark:text-slate-300">Configured Servers</p>
        <InfoTooltip text="Raw JSON shows the effective persisted config for this server after import normalization." />
      </div>
    </div>
    {#if selectedForMove.length > 0}
      <div class="flex items-center gap-3 px-4 py-3 bg-indigo-50 dark:bg-indigo-950/30 border-b border-indigo-200 dark:border-indigo-800">
        <span class="text-sm text-indigo-700 dark:text-indigo-300 font-medium shrink-0">
          {selectedForMove.length} selected
        </span>
        <div class="flex-1 max-w-xs">
          <NamespaceTagSelect
            options={knownNamespaces}
            bind:value={bulkMoveNamespace}
            placeholder="Add to namespace..."
          />
        </div>
        <button
          onclick={moveSelectedServers}
          disabled={!bulkMoveNamespace || bulkMoving}
          class="px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 transition-colors shrink-0"
        >
          {bulkMoving ? 'Adding…' : 'Add'}
        </button>
        <button
          onclick={() => { selectedForMove = []; bulkMoveNamespace = ''; }}
          class="text-sm text-indigo-500 hover:text-indigo-700 dark:hover:text-indigo-300 shrink-0"
        >
          Clear
        </button>
      </div>
    {/if}
    <div class="divide-y divide-slate-100 dark:divide-slate-800">
      {#if loading}
        <div class="p-4 text-sm text-slate-500 dark:text-slate-400">Loading…</div>
      {:else if configServers.length === 0}
        <div class="p-6 text-sm text-slate-500 dark:text-slate-400">
          No servers configured. Add the first downstream server from this panel.
        </div>
      {:else}
        {#each configServers as server}
          {@const runtimeServer = servers.find((item) => item.id === server.id)}
          {@const manualAuthKind = getManualAuthKind(server, runtimeServer)}
          <div class="p-4 flex items-start gap-3">
            <input
              type="checkbox"
              value={server.id}
              bind:group={selectedForMove}
              class="mt-0.5 accent-indigo-600 shrink-0"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <p class="text-sm font-semibold text-slate-900 dark:text-white">{server.id}</p>
                {#each server.namespaces as ns}
                  <span class="text-xs px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300">{ns}</span>
                {/each}
                <span class="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">{server.transport}</span>
                {#if server.transport !== 'stdio' && runtimeServer?.authStatus}
                  <Badge variant={authStatusToBadgeVariant(runtimeServer.authStatus)}>
                    auth {runtimeServer.authStatus}
                  </Badge>
                {/if}
                {#if supportsInteractiveAuth(server) && runtimeServer?.interactiveAuthStatus}
                  <Badge variant={interactiveStatusVariant[runtimeServer.interactiveAuthStatus] ?? 'muted'}>
                    stdio auth {runtimeServer.interactiveAuthStatus}
                  </Badge>
                {/if}
              </div>
              <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">
                {server.transport === 'stdio' ? server.command : server.url}
              </p>
              {#if server.transport !== 'stdio' && runtimeServer?.authMessage}
                <p class="text-xs text-amber-600 dark:text-amber-300 mt-1">
                  {runtimeServer.authMessage}
                </p>
              {/if}
              {#if supportsInteractiveAuth(server) && runtimeServer?.interactiveAuthMessage}
                <p class="text-xs {runtimeServer.interactiveAuthStatus === 'failed' || runtimeServer.interactiveAuthStatus === 'expired' ? 'text-red-600 dark:text-red-300' : 'text-amber-600 dark:text-amber-300'} mt-1">
                  {runtimeServer.interactiveAuthMessage}
                </p>
              {/if}
              {#if supportsInteractiveAuth(server) && runtimeServer?.interactiveAuthUrl}
                <p class="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono break-all">
                  {runtimeServer.interactiveAuthUrl}
                </p>
              {/if}
              {#if runtimeServer?.error}
                <p class="text-xs text-red-600 dark:text-red-300 mt-1">
                  {runtimeServer.error}
                </p>
              {/if}
              <div class="mt-2 flex items-center gap-2">
                <span class="text-xs font-medium text-slate-600 dark:text-slate-400">Enabled</span>
                <InfoTooltip text="When off, this server is excluded from the MCP tool pipeline and routing until turned back on." />
                <Switch
                  checked={server.enabled}
                  ariaLabel={`Toggle server ${server.id} enabled`}
                  disabled={togglingEnabled[server.id] === true}
                  onchange={(next) => toggleServerEnabled(server.id, next)}
                />
              </div>
            </div>
            <div class="flex gap-2 shrink-0">
              {#if manualAuthKind === 'stdio'}
                <button
                  onclick={() => handleAuthenticate(server.id)}
                  disabled={interactiveBusy[server.id] || (runtimeServer ? hasActiveInteractiveAuth(runtimeServer) : false)}
                  class="px-3 py-1.5 text-xs rounded-lg border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 disabled:opacity-50"
                >
                  Authenticate
                </button>
                {#if runtimeServer && hasActiveInteractiveAuth(runtimeServer)}
                  <button
                    onclick={() => handleCancelInteractiveAuth(server.id)}
                    disabled={interactiveBusy[server.id]}
                    class="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 disabled:opacity-50"
                  >
                    Cancel auth
                  </button>
                {/if}
              {/if}
              {#if manualAuthKind === 'oauth'}
                <button
                  onclick={() => connectOAuth(server.id)}
                  disabled={!downstreamAuthCapabilities.oauthStorageEnabled}
                  class="px-3 py-1.5 text-xs rounded-lg border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 disabled:opacity-50"
                >
                  Connect OAuth
                </button>
              {/if}
              {#if manualAuthKind === 'managed_bearer'}
                <button
                  onclick={() => openEdit(server)}
                  class="px-3 py-1.5 text-xs rounded-lg border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300"
                >
                  Configure token
                </button>
              {/if}
              {#if server.auth?.mode === 'oauth' || (server.auth?.mode === 'bearer' && server.auth.source?.type === 'secret')}
                <button onclick={() => clearDownstreamAuth(server.id)} class="px-3 py-1.5 text-xs rounded-lg border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300">
                  Clear auth
                </button>
              {/if}
              <button onclick={() => (rawServerTarget = server)} class="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300">
                Raw JSON
              </button>
              <button onclick={() => openServerSchema(server.id)} class="px-3 py-1.5 text-xs rounded-lg border border-indigo-300 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300">
                View schema
              </button>
              <button onclick={() => openEdit(server)} class="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300">
                Edit
              </button>
              <button onclick={() => (deleteTarget = server)} class="px-3 py-1.5 text-xs rounded-lg border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300">
                Delete
              </button>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>

  {#if loading}
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {#each { length: 3 } as _}
        <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-4 h-24 animate-pulse"></div>
      {/each}
    </div>
  {:else if servers.length > 0}
    <div class="space-y-3">
      <div class="flex items-center gap-2">
        <p class="text-sm font-medium text-slate-700 dark:text-slate-300">Runtime Health</p>
        <InfoTooltip text="Health is collected from the runtime registry. Import warnings still matter even when a server is persisted successfully." />
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {#each servers as server}
          {@const persisted = configServers.find((s) => s.id === server.id)}
          <ServerHealthCard
            {server}
            configServer={persisted}
            oauthStorageEnabled={downstreamAuthCapabilities.oauthStorageEnabled}
            interactiveBusy={interactiveBusy[server.id] === true}
            hasActiveStdioInteractiveAuth={hasActiveInteractiveAuth(server)}
            onRefresh={handleRefresh}
            onInspect={openServerSchema}
            refreshing={refreshing[server.id] ?? false}
            onEnabledToggle={persisted ? (next) => toggleServerEnabled(server.id, next) : undefined}
            togglingEnabled={togglingEnabled[server.id] === true}
            onConnectOAuth={connectOAuth}
            onAuthenticateStdio={handleAuthenticate}
            onCancelStdioAuth={handleCancelInteractiveAuth}
            onConfigureManagedBearer={persisted ? () => openEdit(persisted) : undefined}
          />
        {/each}
      </div>
    </div>
  {/if}
</div>

<Modal
  open={formOpen}
  title={editingId ? 'Edit Server' : formMode === 'import' ? 'Import MCP Servers' : 'Add MCP Server'}
  onclose={() => (formOpen = false)}
>
  {#snippet children()}
    <div class="space-y-4">
      {#if !editingId}
        <div class="flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 text-sm">
          <button
            type="button"
            onclick={() => {
              formMode = 'manual';
              resetImportPreview();
            }}
            class="flex-1 rounded-md px-3 py-1.5 transition-colors {formMode === 'manual'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}"
          >
            Manual
          </button>
          <button
            type="button"
            onclick={() => {
              formMode = 'import';
              resetImportPreview();
            }}
            class="flex-1 rounded-md px-3 py-1.5 transition-colors {formMode === 'import'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}"
          >
            Import JSON
          </button>
        </div>
      {/if}

      {#if editingId || formMode === 'manual'}
      <div class="grid grid-cols-2 gap-3">
        <label class="space-y-1 text-sm">
          <span class="text-slate-600 dark:text-slate-300">ID</span>
          <input bind:value={form.id} autocomplete="off" disabled={Boolean(editingId)} class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
        </label>
        <div class="space-y-1 text-sm col-span-2">
          <span class="text-slate-600 dark:text-slate-300">Namespaces</span>
          <MultiNamespaceSelect options={knownNamespaces} bind:value={form.namespaces} placeholder="Add namespace..." />
        </div>
        <label class="space-y-1 text-sm">
          <span class="text-slate-600 dark:text-slate-300">Transport</span>
          <select autocomplete="off" bind:value={form.transport} class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800">
            <option value="streamable-http">streamable-http</option>
            <option value="http">http</option>
            <option value="stdio">stdio</option>
          </select>
        </label>
        <label class="space-y-1 text-sm">
          <span class="text-slate-600 dark:text-slate-300">Trust Level</span>
          <select autocomplete="off" bind:value={form.trustLevel} class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800">
            <option value="untrusted">untrusted</option>
            <option value="verified">verified</option>
            <option value="internal">internal</option>
          </select>
        </label>
      </div>

      {#if form.transport === 'stdio'}
        <label class="space-y-1 text-sm block">
          <span class="text-slate-600 dark:text-slate-300">Command</span>
          <input bind:value={form.command} autocomplete="off" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
        </label>
        <label class="space-y-1 text-sm block">
          <span class="text-slate-600 dark:text-slate-300">Args</span>
          <input bind:value={argsText} placeholder="arg1, arg2" autocomplete="off" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
        </label>
        <label class="space-y-1 text-sm block">
          <span class="text-slate-600 dark:text-slate-300">Env</span>
          <textarea bind:value={envText} rows="4" placeholder="KEY=value" autocomplete="off" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"></textarea>
        </label>
        <label class="space-y-1 text-sm block">
          <span class="text-slate-600 dark:text-slate-300 inline-flex items-center gap-2">
            Stdio timeout (s)
            <InfoTooltip text="Increase this when the child process needs more time to finish startup or complete browser/device authentication before tools become available." />
          </span>
          <input type="number" autocomplete="off" min="1" bind:value={form.stdioTimeoutSeconds} class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
        </label>
        <label class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={form.stdioInteractiveAuth?.enabled === true}
            onchange={(event) => {
              form.stdioInteractiveAuth = {
                enabled: (event.currentTarget as HTMLInputElement).checked,
              };
            }}
          />
          <span class="inline-flex items-center gap-2">
            Enable interactive auth
            <InfoTooltip text="Enable this only for stdio processes that require browser or device login before tools become available." />
          </span>
        </label>
      {:else}
        <label class="space-y-1 text-sm block">
          <span class="text-slate-600 dark:text-slate-300">URL</span>
          <input bind:value={form.url} autocomplete="url" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
        </label>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label class="space-y-1 text-sm block">
            <span class="text-slate-600 dark:text-slate-300 inline-flex items-center gap-2">
              Auth mode
              <InfoTooltip text="Use env for process-provided bearer tokens. Managed secret and OAuth storage are only available when downstream auth encryption is enabled." />
            </span>
            <select autocomplete="off" bind:value={form.auth!.mode} class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800">
              <option value="none">none</option>
              <option value="bearer">bearer</option>
              <option value="oauth">oauth</option>
            </select>
          </label>
          {#if form.auth?.mode === 'bearer'}
            {#if downstreamAuthCapabilities.managedSecretsEnabled}
              <label class="space-y-1 text-sm block">
                <span class="text-slate-600 dark:text-slate-300">Credential source</span>
                <select
                  value={form.auth.source?.type ?? 'env'}
                  onchange={(event) => {
                    const value = (event.currentTarget as HTMLSelectElement).value as 'env' | 'secret';
                    form.auth = value === 'env'
                      ? { mode: 'bearer', source: { type: 'env', envVar: bearerEnvVar } }
                      : { mode: 'bearer', source: { type: 'secret' } };
                  }}
                  class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                >
                  <option value="env">environment variable</option>
                  <option value="secret">managed secret</option>
                </select>
              </label>
            {/if}
          {/if}
        </div>
        {#if form.auth?.mode === 'bearer'}
          {#if form.auth.source?.type === 'secret' && downstreamAuthCapabilities.managedSecretsEnabled}
            <label class="space-y-1 text-sm block">
              <span class="text-slate-600 dark:text-slate-300 inline-flex items-center gap-2">
                Managed bearer token
                <InfoTooltip text="Stored separately from server config. Leave blank when editing to keep the current secret unchanged." />
              </span>
              <input type="password" bind:value={managedBearerSecret} autocomplete="new-password" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
          {:else}
            <label class="space-y-1 text-sm block">
              <span class="text-slate-600 dark:text-slate-300">Env var</span>
              <input bind:value={bearerEnvVar} placeholder="MCP_SERVER_TOKEN" autocomplete="off" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono text-xs" />
            </label>
          {/if}
        {:else if form.auth?.mode === 'oauth'}
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label class="space-y-1 text-sm block">
              <span class="text-slate-600 dark:text-slate-300">Authorization server</span>
              <input bind:value={oauthAuthorizationServer} placeholder="https://issuer.example.com" autocomplete="url" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1 text-sm block">
              <span class="text-slate-600 dark:text-slate-300">Scopes</span>
              <input bind:value={oauthScopesText} placeholder="openid, profile" autocomplete="off" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1 text-sm block">
              <span class="text-slate-600 dark:text-slate-300">Registration</span>
              <select autocomplete="off" bind:value={oauthRegistrationMode} class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800">
                <option value="dynamic">dynamic</option>
                <option value="static">static</option>
              </select>
            </label>
            {#if oauthRegistrationMode === 'static'}
              <label class="space-y-1 text-sm block">
                <span class="text-slate-600 dark:text-slate-300">Client ID</span>
                <input bind:value={oauthClientId} autocomplete="off" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
              </label>
            {/if}
          </div>
        {/if}
        <label class="space-y-1 text-sm block">
          <span class="text-slate-600 dark:text-slate-300">Headers</span>
          <textarea
            bind:value={headersText}
            rows="4"
            placeholder="HEADER=value"
            autocomplete="off"
            class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono text-xs"
          ></textarea>
        </label>
      {/if}

      <div class="grid grid-cols-2 gap-3">
        <label class="space-y-1 text-sm">
          <span class="text-slate-600 dark:text-slate-300">Refresh interval (s)</span>
          <input type="number" autocomplete="off" bind:value={form.refreshIntervalSeconds} class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
        </label>
        <label class="space-y-1 text-sm">
          <span class="text-slate-600 dark:text-slate-300">Healthcheck interval (s)</span>
          <input type="number" autocomplete="off" bind:value={form.healthcheck!.intervalSeconds} class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
        </label>
      </div>

      <div class="flex gap-6 text-sm text-slate-600 dark:text-slate-300">
        <label class="flex items-center gap-2"><input type="checkbox" bind:checked={form.enabled} /> Enabled</label>
        <label class="flex items-center gap-2"><input type="checkbox" bind:checked={healthcheckEnabled} /> Healthcheck</label>
        <label class="flex items-center gap-2 text-slate-600 dark:text-slate-300">
          <input type="checkbox" bind:checked={discoveryAuto} />
          <span class="inline-flex items-center gap-1">
            Periodic catalog refresh
            <InfoTooltip text="When enabled, the gateway polls for tool list updates on an interval. Uses Refresh interval below, or 300 seconds if unset." />
          </span>
        </label>
      </div>
      {:else}
        <div class="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div class="grid grid-cols-1 md:grid-cols-[220px,1fr] gap-3">
            <label class="space-y-1 text-sm">
              <span class="text-slate-600 dark:text-slate-300 inline-flex items-center gap-2">
                Default namespace
                <InfoTooltip text="Paste Cursor-style mcpServers, a fragment, or a flat server map. Extra wrapper text and trailing commas are tolerated." />
              </span>
              <input
                bind:value={importDefaultNamespace}
                oninput={resetImportPreview}
                list="server-namespaces"
                placeholder="default"
                autocomplete="off"
                class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
              />
            </label>
            <div class="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 px-3 py-3 text-xs text-slate-500 dark:text-slate-400 flex items-start gap-2">
              <span class="font-medium">Normalization</span>
              <InfoTooltip text="Entries with url default to streamable-http. Entries with command default to stdio. Command lines are split into executable plus args before persistence." />
            </div>
          </div>

          <div class="flex items-center justify-between gap-2">
            <label class="space-y-1 text-sm block flex-1 min-w-0">
              <span class="text-slate-600 dark:text-slate-300">Import JSON</span>
              <textarea
                bind:value={importJsonText}
                oninput={resetImportPreview}
                onpaste={handleImportPaste}
                rows="14"
                placeholder={`{"mcpServers":{"context7":{"url":"https://mcp.context7.com/mcp","headers":{"CONTEXT7_API_KEY":"api"}}}}`}
                class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono text-xs"
              ></textarea>
            </label>
          </div>
          <button
            type="button"
            onclick={formatImportJson}
            class="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            Format / normalize JSON
          </button>

          {#if importClientError}
            <div class="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-3 text-sm text-red-700 dark:text-red-300">
              {importClientError}
            </div>
          {/if}

          {#if importPreview}
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div class="space-y-3">
                <div class="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-3">
                  <div class="flex items-center gap-2">
                    <p class="text-sm font-medium text-slate-900 dark:text-white">Servers ready to import</p>
                    <InfoTooltip text="Raw JSON below is the effective config that will be persisted after import normalization. Stdio servers are saved without runtime validation and must be refreshed manually." />
                  </div>
                  <div class="mt-3 space-y-2">
                    {#if importPreview.normalizedServers.length === 0}
                      <p class="text-sm text-slate-500 dark:text-slate-400">No valid servers yet.</p>
                    {:else}
                      {#each importPreview.normalizedServers as server}
                        <div class="rounded-lg bg-slate-50 dark:bg-slate-800/70 px-3 py-2 text-sm">
                          <p class="font-medium text-slate-900 dark:text-white">{server.id}</p>
                          <p class="text-slate-500 dark:text-slate-400">{server.namespaces.join(', ')} · {server.transport}</p>
                          <pre class="mt-2 overflow-x-auto rounded-lg bg-slate-950 px-3 py-2 text-xs text-slate-100">{JSON.stringify(server, null, 2)}</pre>
                        </div>
                      {/each}
                    {/if}
                  </div>
                </div>

                <div class="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-3">
                  <p class="text-sm font-medium text-slate-900 dark:text-white">Namespaces to create</p>
                  <div class="mt-2 flex flex-wrap gap-2">
                    {#if importPreview.namespacesToCreate.length === 0}
                      <span class="text-sm text-slate-500 dark:text-slate-400">None</span>
                    {:else}
                      {#each importPreview.namespacesToCreate as namespace}
                        <span class="text-xs px-2 py-1 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300">{namespace}</span>
                      {/each}
                    {/if}
                  </div>
                </div>
              </div>

              <div class="space-y-3">
                <div class="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-3">
                  <p class="text-sm font-medium text-slate-900 dark:text-white">Conflicts</p>
                  <div class="mt-3 space-y-2">
                    {#if importPreview.conflicts.length === 0}
                      <p class="text-sm text-slate-500 dark:text-slate-400">No ID conflicts.</p>
                    {:else}
                      {#each importPreview.conflicts as conflict}
                        <div class="rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                          <strong>{conflict.id}</strong>: {conflict.message}
                        </div>
                      {/each}
                    {/if}
                  </div>
                </div>

                <div class="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-3">
                  <p class="text-sm font-medium text-slate-900 dark:text-white">Validation errors</p>
                  <div class="mt-3 space-y-2">
                    {#if importPreview.validationErrors.length === 0}
                      <p class="text-sm text-slate-500 dark:text-slate-400">No validation errors.</p>
                    {:else}
                      {#each importPreview.validationErrors as issue}
                        <div class="rounded-lg bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                          <strong>{issue.id}</strong> · {issue.field}: {issue.message}
                        </div>
                      {/each}
                    {/if}
                  </div>
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/snippet}
  {#snippet footer()}
    <button onclick={() => (formOpen = false)} class="px-4 py-2 text-sm text-slate-700 dark:text-slate-300">Cancel</button>
    {#if editingId || formMode === 'manual'}
      <button onclick={saveServer} disabled={saving} class="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50">
        {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Server'}
      </button>
    {:else}
      <button
        onclick={previewImport}
        disabled={importPreviewLoading}
        class="px-4 py-2 text-sm text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 rounded-lg disabled:opacity-50"
      >
        {importPreviewLoading ? 'Previewing…' : 'Preview Import'}
      </button>
      <button
        onclick={runImport}
        disabled={saving || !importPreview || importHasBlockingIssues || importPreview.normalizedServers.length === 0}
        class="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50"
      >
        {saving ? 'Importing…' : 'Import Servers'}
      </button>
    {/if}
  {/snippet}
</Modal>

<ServerSchemaDrawer detail={serverSchemaDetail} onclose={() => (serverSchemaDetail = null)} />

<Modal open={rawServerTarget !== null} title={`Raw JSON · ${rawServerTarget?.id ?? ''}`} onclose={() => (rawServerTarget = null)}>
  {#snippet children()}
    <label class="space-y-1 text-sm block">
      <span class="text-slate-600 dark:text-slate-300 inline-flex items-center gap-2">
        Effective persisted config
        <InfoTooltip text="This is the exact server object persisted in the admin config and bootstrap.json file mode." />
      </span>
      {#key rawServerTarget?.id ?? ''}
        <JsonSchemaEditor
          readOnly={true}
          value={formatServerJson(rawServerTarget)}
          scrollerMinHeight="22rem"
        />
      {/key}
    </label>
  {/snippet}
  {#snippet footer()}
    <button onclick={() => (rawServerTarget = null)} class="px-4 py-2 text-sm text-slate-700 dark:text-slate-300">Close</button>
  {/snippet}
</Modal>

<Modal open={deleteTarget !== null} title="Delete Server" onclose={() => (deleteTarget = null)}>
  {#snippet children()}
    <p class="text-sm text-slate-600 dark:text-slate-400">
      Delete server <strong>{deleteTarget?.id}</strong>? The runtime registry will be reapplied immediately.
    </p>
  {/snippet}
  {#snippet footer()}
    <button onclick={() => (deleteTarget = null)} class="px-4 py-2 text-sm text-slate-700 dark:text-slate-300">Cancel</button>
    <button onclick={confirmDelete} disabled={saving} class="px-4 py-2 text-sm text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50">
      {saving ? 'Deleting…' : 'Delete'}
    </button>
  {/snippet}
</Modal>
