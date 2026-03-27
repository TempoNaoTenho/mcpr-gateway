<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getNamespaces,
    getPolicies,
    getConfigServers,
    savePolicies,
    updateConfigServer,
    deleteNamespace,
    ApiError,
    type NamespaceSummary,
    type PoliciesConfig,
    type ConfigServer,
  } from '$lib/api.js';
  import { notifications } from '$lib/stores/notifications.js';
  import Badge from '../../components/ui/Badge.svelte';
  import InfoTooltip from '../../components/ui/InfoTooltip.svelte';
  import Switch from '../../components/ui/Switch.svelte';
  import Modal from '../../components/ui/Modal.svelte';

  const ALL_MODES = ['read', 'write', 'admin'];

  let loading = $state(true);
  let saving = $state(false);
  let deleting = $state(false);
  let namespaces = $state<NamespaceSummary[]>([]);
  let policies = $state<PoliciesConfig | null>(null);
  let configServers = $state<ConfigServer[]>([]);
  let selectedNamespaceKey = $state('');
  let draft = $state<{
    bootstrapWindowSize: number;
    candidatePoolSize: number;
    allowedModes: string[];
    gatewayMode: 'compat' | 'code' | 'default';
    selectedServerIds: string[];
    disabledTools: { serverId: string; name: string }[];
  } | null>(null);

  let deleteConfirmOpen = $state(false);

  async function load() {
    loading = true;
    try {
      const [namespaceRes, policiesRes, serversRes] = await Promise.all([
        getNamespaces(),
        getPolicies(),
        getConfigServers(),
      ]);
      namespaces = namespaceRes.namespaces;
      policies = policiesRes;
      configServers = serversRes.servers;

      const preferredKey = selectedNamespaceKey && namespaceRes.namespaces.some((ns) => ns.key === selectedNamespaceKey)
        ? selectedNamespaceKey
        : namespaceRes.namespaces[0]?.key ?? '';
      selectNamespace(preferredKey, namespaceRes.namespaces, policiesRes);
    } catch {
      notifications.error('Failed to load namespaces');
    } finally {
      loading = false;
    }
  }

  function selectNamespace(key: string, source = namespaces, policyBundle: PoliciesConfig | null = policies) {
    selectedNamespaceKey = key;
    const ns = source.find((entry) => entry.key === key);
    const nsPolicy = policyBundle?.namespaces[key];
    draft = ns
      ?         {
          bootstrapWindowSize: ns.bootstrapWindowSize,
          candidatePoolSize: ns.candidatePoolSize,
          allowedModes: [...ns.allowedModes],
          gatewayMode: ns.gatewayMode,
          selectedServerIds: ns.servers.map((server) => server.id),
          disabledTools: [...(nsPolicy?.disabledTools ?? [])],
        }
      : null;
  }

  function setToolEnabled(serverId: string, name: string, enabled: boolean) {
    if (!draft) return;
    const rest = draft.disabledTools.filter((r) => r.serverId !== serverId || r.name !== name);
    draft.disabledTools = enabled ? rest : [...rest, { serverId, name }];
  }

  function isDraftToolEnabled(serverId: string, name: string): boolean {
    if (!draft) return true;
    return !draft.disabledTools.some((r) => r.serverId === serverId && r.name === name);
  }

  function toggleMode(mode: string) {
    if (!draft) return;
    draft.allowedModes = draft.allowedModes.includes(mode)
      ? draft.allowedModes.filter((entry) => entry !== mode)
      : [...draft.allowedModes, mode];
  }

  function toggleServer(serverId: string) {
    if (!draft) return;
    draft.selectedServerIds = draft.selectedServerIds.includes(serverId)
      ? draft.selectedServerIds.filter((entry) => entry !== serverId)
      : [...draft.selectedServerIds, serverId];
  }

  async function saveSelectedNamespace() {
    if (!draft || !policies) return;
    const currentNamespace = namespaces.find((entry) => entry.key === selectedNamespaceKey);
    if (!currentNamespace) return;

    saving = true;
    try {
      const nextPolicies: PoliciesConfig = {
        ...policies,
        namespaces: {
          ...policies.namespaces,
          [selectedNamespaceKey]: {
            ...policies.namespaces[selectedNamespaceKey],
            bootstrapWindowSize: Number(draft.bootstrapWindowSize),
            candidatePoolSize: Number(draft.candidatePoolSize),
            allowedModes: draft.allowedModes,
            gatewayMode: draft.gatewayMode,
            disabledTools: draft.disabledTools,
          },
        },
      };

      await savePolicies(nextPolicies, `Updated namespace ${selectedNamespaceKey}`);

      const currentAssigned = new Set(currentNamespace.servers.map((server) => server.id));
      const nextAssigned = new Set(draft.selectedServerIds);
      const changedServers = configServers.filter((server) => currentAssigned.has(server.id) !== nextAssigned.has(server.id));

      await Promise.all(
        changedServers.map((server) => {
          const nextNamespaces = nextAssigned.has(server.id)
            ? [...new Set([...server.namespaces, selectedNamespaceKey])]
            : server.namespaces.filter((namespace) => namespace !== selectedNamespaceKey);
          return updateConfigServer(server.id, { namespaces: nextNamespaces });
        }),
      );

      notifications.success(`Updated namespace ${selectedNamespaceKey}`);
      await load();
    } catch (err) {
      notifications.error(err instanceof Error ? err.message : 'Failed to save namespace');
    } finally {
      saving = false;
    }
  }

  async function confirmDeleteNamespace() {
    if (!selectedNamespaceKey) return;
    deleting = true;
    try {
      await deleteNamespace(selectedNamespaceKey, `Deleted namespace ${selectedNamespaceKey}`);
      notifications.success(`Deleted namespace ${selectedNamespaceKey}`);
      deleteConfirmOpen = false;
      selectedNamespaceKey = '';
      await load();
    } catch (err) {
      const msg =
        err instanceof ApiError && err.details && Array.isArray((err.details as { serverIds?: string[] }).serverIds)
          ? `${err.message}: ${(err.details as { serverIds: string[] }).serverIds.join(', ')}`
          : err instanceof Error
            ? err.message
            : 'Failed to delete namespace';
      notifications.error(msg);
    } finally {
      deleting = false;
    }
  }

  onMount(load);

  let selectedNamespace = $derived(namespaces.find((entry) => entry.key === selectedNamespaceKey) ?? null);
  let defaultModeActive = $derived(draft?.gatewayMode === 'default');
  let codeModeActive = $derived(draft?.gatewayMode === 'code');
  let budgetControlsDisabled = $derived(codeModeActive || defaultModeActive);

  /** Servers that only have this namespace; deleting would leave them with zero namespaces. */
  let serverIdsBlockingDelete = $derived.by(() => {
    if (!selectedNamespaceKey) return [];
    return configServers
      .filter(
        (s) =>
          s.namespaces.includes(selectedNamespaceKey) &&
          s.namespaces.length === 1
      )
      .map((s) => s.id);
  });
  let deleteNamespaceBlocked = $derived(serverIdsBlockingDelete.length > 0);
</script>

<svelte:head>
  <title>Namespaces — MCPR Gateway</title>
</svelte:head>

<div class="space-y-6">
  <div class="flex items-center justify-between gap-3">
    <div class="flex items-center gap-2">
      <h1 class="text-xl font-semibold text-slate-900 dark:text-white">Namespaces</h1>
      <InfoTooltip text="Namespaces are the operational workspace for tool budgets, server composition, and future advanced tuning. Access control stays focused on profiles and client tokens." />
    </div>
    <button
      onclick={saveSelectedNamespace}
      disabled={!draft || saving || loading}
      class="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 transition-colors"
    >
      {saving ? 'Saving…' : 'Save Namespace'}
    </button>
  </div>

  <div class="grid gap-6 xl:grid-cols-[320px_1fr]">
    <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <p class="text-sm font-semibold text-slate-900 dark:text-white">Namespace catalog</p>
      </div>
      {#if loading}
        <div class="px-4 py-8 text-sm text-slate-500 dark:text-slate-400">Loading…</div>
      {:else if namespaces.length === 0}
        <div class="px-4 py-8 text-sm text-slate-500 dark:text-slate-400">No namespaces configured.</div>
      {:else}
        <div class="divide-y divide-slate-100 dark:divide-slate-800">
          {#each namespaces as namespace}
            <button
              type="button"
              onclick={() => selectNamespace(namespace.key)}
              class="w-full px-4 py-3 text-left transition-colors {selectedNamespaceKey === namespace.key ? 'bg-indigo-50 dark:bg-indigo-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'}"
            >
              <div class="flex items-center justify-between gap-3">
                <span class="font-medium text-sm text-slate-900 dark:text-white">{namespace.key}</span>
                <Badge variant="muted">~{namespace.metrics.totalTokens}</Badge>
              </div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {namespace.metrics.toolCount} tools · {namespace.metrics.serverCount} servers
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="space-y-5">
      {#if !selectedNamespace || !draft}
        <div class="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 px-4 py-10 text-sm text-slate-500 dark:text-slate-400 text-center">
          Select a namespace to inspect runtime budget and server composition.
        </div>
      {:else}
        <div class="grid gap-3 md:grid-cols-4">
          <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <p class="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Visible tools</p>
            <p class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">{selectedNamespace.metrics.toolCount}</p>
          </div>
          <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <p class="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Schema tokens</p>
            <p class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">~{selectedNamespace.metrics.schemaTokens}</p>
          </div>
          <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <p class="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Avg tokens / tool</p>
            <p class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">~{selectedNamespace.metrics.averageTokensPerTool}</p>
          </div>
          <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <p class="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Customized tools</p>
            <p class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">{selectedNamespace.metrics.customizedTools}</p>
          </div>
        </div>

        <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-5">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 class="text-base font-semibold text-slate-900 dark:text-white">{selectedNamespace.key}</h2>
              <div class="mt-1 flex gap-1.5 flex-wrap">
                {#each selectedNamespace.allowedRoles as role}
                  <Badge variant="info">{role}</Badge>
                {/each}
              </div>
            </div>
            <button
              type="button"
              onclick={() => (deleteConfirmOpen = true)}
              disabled={deleteNamespaceBlocked || deleting}
              class="px-3 py-2 text-sm font-medium rounded-lg border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Delete namespace
            </button>
          </div>

          {#if deleteNamespaceBlocked}
            <p class="text-xs text-amber-700 dark:text-amber-300">
              Cannot delete: assign another namespace to server(s) first —
              {serverIdsBlockingDelete.join(', ')}
            </p>
          {/if}

          <div class="space-y-3">
            <div class="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
              Allowed actions
              <InfoTooltip text="Action modes remain namespace-scoped because they affect the tool window exposed to each session." />
            </div>
            <div class="flex gap-3 flex-wrap">
              {#each ALL_MODES as mode}
                <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={draft.allowedModes.includes(mode)}
                    onchange={() => toggleMode(mode)}
                    class="rounded border-slate-300 dark:border-slate-600"
                  />
                  {mode}
                </label>
              {/each}
            </div>
          </div>

          <div class="space-y-3">
            <div class="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
              Gateway mode
              <InfoTooltip text="Default mode exposes enabled downstream tools directly. Compat mode exposes search/call meta-tools. Code mode exposes gateway_run_code and help." />
            </div>
            <div class="flex gap-4">
              <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="radio"
                  name="gatewayMode"
                  value="default"
                  checked={draft.gatewayMode === 'default'}
                  onchange={() => { if (draft) draft.gatewayMode = 'default' }}
                  class="border-slate-300 dark:border-slate-600"
                />
                default
              </label>
              <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="radio"
                  name="gatewayMode"
                  value="compat"
                  checked={draft.gatewayMode === 'compat'}
                  onchange={() => { if (draft) draft.gatewayMode = 'compat' }}
                  class="border-slate-300 dark:border-slate-600"
                />
                compat
              </label>
              <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="radio"
                  name="gatewayMode"
                  value="code"
                  checked={draft.gatewayMode === 'code'}
                  onchange={() => { if (draft) draft.gatewayMode = 'code' }}
                  class="border-slate-300 dark:border-slate-600"
                />
                code
              </label>
            </div>
          </div>

          <div class="space-y-3" class:opacity-50={budgetControlsDisabled}>
            <div class="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
              Runtime budget
              <InfoTooltip
                text={codeModeActive
                  ? 'Bootstrap window and candidate pool apply to compat-mode selection, not to the code-mode runtime catalog. Switch to compat to edit these values.'
                  : defaultModeActive
                    ? 'Bootstrap window and candidate pool do not apply in default mode because the client receives the enabled downstream catalog directly. Switch to compat to edit these values.'
                  : 'These values control how many tools can participate in selection and how much schema enters the client-visible window over time in compat mode.'}
              />
            </div>
            <div class="grid gap-3 md:grid-cols-2">
              <label class="space-y-1">
                <div class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                  Bootstrap window
                  <InfoTooltip text="Number of tools used in the initial selector/bootstrap pipeline (compat mode)." />
                </div>
                <input
                  type="number"
                  autocomplete="off"
                  bind:value={draft.bootstrapWindowSize}
                  min="1"
                  disabled={budgetControlsDisabled}
                  class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-60"
                />
              </label>
              <label class="space-y-1">
                <div class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                  Candidate pool
                  <InfoTooltip text="Size of the ranked candidate pool for the selector (compat mode)." />
                </div>
                <input
                  type="number"
                  autocomplete="off"
                  bind:value={draft.candidatePoolSize}
                  min="1"
                  disabled={budgetControlsDisabled}
                  class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:opacity-60"
                />
              </label>
            </div>
          </div>

          <div class="space-y-3">
            <div class="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
              Assigned servers
              <InfoTooltip text="Server assignment controls which imported tools contribute schema tokens to this namespace." />
            </div>
            <div class="grid gap-2 md:grid-cols-2">
              {#each configServers as server}
                <label class="flex items-start gap-3 rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                  <input
                    type="checkbox"
                    checked={draft.selectedServerIds.includes(server.id)}
                    onchange={() => toggleServer(server.id)}
                    class="mt-0.5 rounded border-slate-300 dark:border-slate-600"
                  />
                  <div>
                    <div class="text-sm font-medium text-slate-900 dark:text-white">{server.id}</div>
                    <div class="text-xs text-slate-500 dark:text-slate-400">{server.transport} · {server.namespaces.join(', ')}</div>
                  </div>
                </label>
              {/each}
            </div>
          </div>
        </div>

        <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
            <div class="flex items-center gap-2">
              <p class="text-sm font-semibold text-slate-900 dark:text-white">Effective tools</p>
              <InfoTooltip text="Token estimates are computed from the effective public tool payload: name, description, and input schema after overrides. Row switches exclude a tool from this namespace (saved with Save Namespace)." />
            </div>
          </div>
          <table class="w-full text-sm">
            <thead>
              <tr class="bg-slate-50 dark:bg-slate-950/40 border-b border-slate-200 dark:border-slate-800">
                <th class="w-12 px-3 py-3 text-left font-medium text-slate-500 dark:text-slate-400" scope="col">
                  <span class="sr-only">Enabled</span>
                </th>
                <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Tool</th>
                <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Server</th>
                <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">State</th>
                <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Tokens</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
              {#each selectedNamespace.tools as tool}
                <tr>
                  <td class="px-3 py-3 align-middle">
                    <Switch
                      checked={isDraftToolEnabled(tool.serverId, tool.name)}
                      ariaLabel={`Enable tool ${tool.name} on ${tool.serverId}`}
                      onchange={(next) => setToolEnabled(tool.serverId, tool.name, next)}
                    />
                  </td>
                  <td class="px-4 py-3 font-mono text-xs text-slate-800 dark:text-slate-200">{tool.name}</td>
                  <td class="px-4 py-3 text-slate-600 dark:text-slate-400">{tool.serverId}</td>
                  <td class="px-4 py-3">
                    <Badge variant={tool.customized ? 'warning' : 'muted'}>
                      {tool.customized ? 'customized' : 'inherited'}
                    </Badge>
                  </td>
                  <td class="px-4 py-3 text-slate-600 dark:text-slate-400">~{tool.totalTokens}</td>
                </tr>
              {/each}
              {#if selectedNamespace.tools.length === 0}
                <tr>
                  <td colspan="5" class="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                    No effective tools are currently assigned to this namespace.
                  </td>
                </tr>
              {/if}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  </div>
</div>

<Modal open={deleteConfirmOpen} title="Delete namespace" onclose={() => (deleteConfirmOpen = false)}>
  <p class="text-sm text-slate-700 dark:text-slate-300">
    Permanently remove namespace <span class="font-mono">{selectedNamespaceKey}</span> from policy, profile allow-lists, starter packs, and server assignments. This cannot be undone from the UI.
  </p>
  {#snippet footer()}
    <button
      type="button"
      onclick={() => (deleteConfirmOpen = false)}
      class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
    >
      Cancel
    </button>
    <button
      type="button"
      onclick={confirmDeleteNamespace}
      disabled={deleting}
      class="px-4 py-2 text-sm font-medium rounded-lg text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
    >
      {deleting ? 'Deleting…' : 'Delete'}
    </button>
  {/snippet}
</Modal>
