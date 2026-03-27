<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import {
    getTools,
    getServers,
    getConfigServers,
    refreshServer,
    saveToolOverride,
    deleteToolOverride,
    type ToolRecord,
    type ServerInfo,
    type ConfigServer,
  } from '$lib/api.js';
  import { notifications } from '$lib/stores/notifications.js';
  import {
    getAutoRefreshReason,
    getManualAuthKind,
    shouldSkipAutoRefreshCooldown,
    type AutoRefreshCooldownEntry,
  } from '$lib/serverAuthFlow.js';
  import { validateToolInputSchema } from '$lib/validateToolInputSchema.js';
  import Badge from '../../components/ui/Badge.svelte';
  import InfoTooltip from '../../components/ui/InfoTooltip.svelte';
  import ToolDetailDrawer from '../../components/domain/ToolDetailDrawer.svelte';

  let tools = $state<ToolRecord[]>([]);
  let servers = $state<ServerInfo[]>([]);
  let configServers = $state<ConfigServer[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let serverFilter = $state('');
  let namespaceFilter = $state('');
  let riskFilter = $state('');
  let searchQuery = $state('');
  let selectedTool = $state<ToolRecord | null>(null);
  let editorText = $state('');
  let descriptionText = $state('');
  let parseError = $state('');
  let parseErrorTimer: ReturnType<typeof setTimeout> | null = null;
  const autoRefreshCooldown = new Map<string, AutoRefreshCooldownEntry>();
  let refreshingServerId = $state<Record<string, boolean>>({});

  function clearParseErrorTimer() {
    if (parseErrorTimer) {
      clearTimeout(parseErrorTimer);
      parseErrorTimer = null;
    }
  }

  function scheduleParseError(text: string) {
    clearParseErrorTimer();
    parseErrorTimer = setTimeout(() => {
      parseErrorTimer = null;
      const result = validateToolInputSchema(text);
      parseError = result.ok ? '' : result.message;
    }, 250);
  }

  let schemaSaveBlocked = $derived(!validateToolInputSchema(editorText).ok);

  async function load() {
    loading = true;
    try {
      const [toolsRes, serversRes, configRes] = await Promise.all([
        getTools({ serverId: serverFilter || undefined, namespace: namespaceFilter || undefined }),
        getServers(),
        getConfigServers(),
      ]);
      tools = toolsRes.tools;
      servers = serversRes.servers;
      configServers = configRes.servers;
      if (selectedTool) {
        selectedTool = toolsRes.tools.find((tool) => (
          tool.serverId === selectedTool?.serverId && tool.name === selectedTool?.name
        )) ?? null;
        if (selectedTool) syncEditorFromTool(selectedTool);
      }
    } catch {
      notifications.error('Failed to load tools');
    } finally {
      loading = false;
    }
  }

  function getConfigServerById(id: string): ConfigServer | undefined {
    return configServers.find((server) => server.id === id);
  }

  function hasActiveInteractiveAuth(server: ServerInfo): boolean {
    return server.interactiveAuthStatus === 'starting' || server.interactiveAuthStatus === 'pending';
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
        || refreshingServerId[runtimeServer.id]
      ) {
        continue;
      }
      candidates.push({ id: runtimeServer.id, reason });
    }

    return candidates;
  }

  async function runAutoRefresh(runtimeServers: ServerInfo[] = servers) {
    const candidates = getPendingAutoRefresh(runtimeServers);
    if (candidates.length === 0) return;

    const now = Date.now();
    for (const candidate of candidates) {
      autoRefreshCooldown.set(candidate.id, { logicalReason: candidate.reason, lastAttemptAt: now });
    }

    await Promise.all(
      candidates.map(async ({ id }) => {
        refreshingServerId = { ...refreshingServerId, [id]: true };
        try {
          await refreshServer(id).catch(() => undefined);
        } finally {
          const next = { ...refreshingServerId };
          delete next[id];
          refreshingServerId = next;
        }
      }),
    );

    await load();
  }

  async function pollRuntime() {
    const shouldPoll = servers.some(hasActiveInteractiveAuth) || getPendingAutoRefresh().length > 0;
    if (!shouldPoll) return;

    try {
      const [serversRes, configRes] = await Promise.all([
        getServers(),
        getConfigServers(),
      ]);
      servers = serversRes.servers;
      configServers = configRes.servers;
      await runAutoRefresh(serversRes.servers);
    } catch {
      // Avoid noisy background errors while the runtime settles.
    }
  }

  function syncEditorFromTool(tool: ToolRecord) {
    clearParseErrorTimer();
    editorText = JSON.stringify(tool.effectiveInputSchema, null, 2);
    descriptionText = tool.effectiveDescription ?? '';
    parseError = '';
  }

  function openTool(tool: ToolRecord) {
    selectedTool = tool;
    syncEditorFromTool(tool);
  }

  async function saveSelectedTool() {
    if (!selectedTool) return;
    const validated = validateToolInputSchema(editorText);
    if (!validated.ok) {
      parseError = validated.message;
      return;
    }
    clearParseErrorTimer();
    parseError = '';
    const inputSchema = validated.value;

    saving = true;
    try {
      await saveToolOverride(selectedTool.serverId, selectedTool.name, {
        description: descriptionText,
        inputSchema,
      });
      await load();
      notifications.success(`Saved override for ${selectedTool.name}`);
    } catch (err) {
      notifications.error(err instanceof Error ? err.message : 'Failed to save override');
    } finally {
      saving = false;
    }
  }

  async function revertSelectedTool() {
    if (!selectedTool?.customized) return;
    saving = true;
    try {
      await deleteToolOverride(selectedTool.serverId, selectedTool.name);
      await load();
      notifications.success(`Reverted ${selectedTool.name} to the imported schema`);
    } catch (err) {
      notifications.error(err instanceof Error ? err.message : 'Failed to revert override');
    } finally {
      saving = false;
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

  let availableNamespaces = $derived([...new Set(tools.flatMap((tool) => tool.serverNamespaces))].sort());

  let serversNeedingManualAuth = $derived(
    servers.filter((s) => s.enabled && s.toolCount === 0 && getManualAuthKind(getConfigServerById(s.id), s)),
  );

  let filtered = $derived(tools.filter((tool) => {
    if (riskFilter && tool.riskLevel !== riskFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        tool.name.toLowerCase().includes(q) ||
        (tool.effectiveDescription ?? '').toLowerCase().includes(q) ||
        tool.serverId.toLowerCase().includes(q)
      );
    }
    return true;
  }));

  const riskVariant: Record<string, 'success' | 'warning' | 'danger' | 'muted'> = {
    low: 'success',
    medium: 'warning',
    high: 'danger',
  };
</script>

<svelte:head>
  <title>Tools — MCPR Gateway</title>
</svelte:head>

<div class="space-y-5">
  <div class="flex items-center justify-between gap-3">
    <div>
      <div class="flex items-center gap-2">
        <h1 class="text-xl font-semibold text-slate-900 dark:text-white">Tools</h1>
        <InfoTooltip text="Customize the effective description and input schema published to MCP clients. Imported definitions remain preserved as the source of truth." />
      </div>
      <p class="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{filtered.length} of {tools.length} tools</p>
    </div>
  </div>

  {#if serversNeedingManualAuth.length > 0}
    <div class="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-200 flex flex-wrap items-center gap-2">
      <span class="inline-flex items-center gap-1 font-medium shrink-0">
        Servers need attention
        <InfoTooltip text="Some downstream servers report zero tools until OAuth, a managed token, or stdio interactive auth completes. Use the Servers page to connect or refresh." />
      </span>
      <span class="text-amber-800/90 dark:text-amber-300/90">
        {serversNeedingManualAuth.length} server{serversNeedingManualAuth.length === 1 ? '' : 's'}
      </span>
      <a
        href="{base}/servers"
        class="text-indigo-600 dark:text-indigo-400 font-medium hover:underline shrink-0"
      >
        Open Servers
      </a>
    </div>
  {/if}

  <div class="flex flex-wrap gap-3">
    <input
      type="search"
      autocomplete="off"
      bind:value={searchQuery}
      placeholder="Search tools…"
      class="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-56"
    />

    <select
      autocomplete="off"
      bind:value={serverFilter}
      onchange={() => load()}
      class="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    >
      <option value="">All servers</option>
      {#each servers as server}
        <option value={server.id}>{server.id}</option>
      {/each}
    </select>

    <select
      autocomplete="off"
      bind:value={namespaceFilter}
      onchange={() => load()}
      class="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    >
      <option value="">All namespaces</option>
      {#each availableNamespaces as namespace}
        <option value={namespace}>{namespace}</option>
      {/each}
    </select>

    <select
      autocomplete="off"
      bind:value={riskFilter}
      class="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    >
      <option value="">All risk levels</option>
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="high">High</option>
    </select>
  </div>

  <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Tool</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">State</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Description</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Server</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Namespace</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Tokens</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Risk</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400"></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
        {#if loading}
          {#each { length: 6 } as _}
            <tr>
              {#each { length: 8 } as _}
                <td class="px-4 py-3">
                  <div class="h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse w-3/4"></div>
                </td>
              {/each}
            </tr>
          {/each}
        {:else if filtered.length === 0}
          <tr>
            <td colspan="8" class="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
              No tools found
            </td>
          </tr>
        {:else}
          {#each filtered as tool}
            <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
              <td class="px-4 py-3 font-medium text-slate-800 dark:text-slate-200 font-mono text-xs">{tool.name}</td>
              <td class="px-4 py-3">
                <Badge variant={tool.customized ? 'warning' : 'muted'}>
                  {tool.customized ? 'customized' : 'inherited'}
                </Badge>
              </td>
              <td 
                class="px-4 py-3 text-slate-600 dark:text-slate-400 max-w-xl min-w-[12rem] whitespace-normal break-words cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 truncate"
                title="Click to customize"
                onclick={() => openTool(tool)}
                role="button"
                tabindex="0"
                onkeydown={(e) => e.key === 'Enter' && openTool(tool)}
              >{tool.effectiveDescription ? (tool.effectiveDescription.length > 100 ? tool.effectiveDescription.slice(0, 100) + '…' : tool.effectiveDescription) : '—'}</td>
              <td class="px-4 py-3 text-slate-600 dark:text-slate-400">{tool.serverId}</td>
              <td class="px-4 py-3 text-slate-600 dark:text-slate-400">{tool.namespace}</td>
              <td class="px-4 py-3 text-slate-600 dark:text-slate-400">~{tool.totalTokens}</td>
              <td class="px-4 py-3">
                <Badge variant={riskVariant[tool.riskLevel] ?? 'muted'}>
                  {tool.riskLevel}
                </Badge>
              </td>
              <td class="px-4 py-3 text-right">
                <button
                  onclick={() => openTool(tool)}
                  class="px-3 py-1.5 text-xs rounded-lg border border-indigo-300 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300"
                >
                  Customize
                </button>
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
</div>

<ToolDetailDrawer
  tool={selectedTool}
  {editorText}
  {descriptionText}
  {parseError}
  saveDisabled={schemaSaveBlocked}
  {saving}
  onclose={() => {
    clearParseErrorTimer();
    selectedTool = null;
  }}
  onEditorInput={(value) => {
    editorText = value;
    scheduleParseError(value);
  }}
  onDescriptionInput={(value) => { descriptionText = value; }}
  onsave={saveSelectedTool}
  onrevert={revertSelectedTool}
/>
