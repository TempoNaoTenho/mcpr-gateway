<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getNamespaces,
    getPolicies,
    getConfigServers,
    savePolicies,
    updateConfigServer,
    deleteNamespace,
    createNamespace,
    ApiError,
    type NamespaceSummary,
    type PoliciesConfig,
    type ConfigServer,
  } from '$lib/api.js';
  import { INSTRUCTIONS_SERVERS_PLACEHOLDER } from '$lib/instructions-placeholder.js';
  import { notifications } from '$lib/stores/notifications.js';
  import Badge from '../../components/ui/Badge.svelte';
  import InfoTooltip from '../../components/ui/InfoTooltip.svelte';
  import Switch from '../../components/ui/Switch.svelte';
  import Modal from '../../components/ui/Modal.svelte';
  import DescriptionEditor from '../../components/domain/DescriptionEditor.svelte';

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
    telemetryEnabled: boolean;
    selectedServerIds: string[];
    disabledTools: { serverId: string; name: string }[];
    customInstructions: { compat: string; code: string };
  } | null>(null);

  let deleteConfirmOpen = $state(false);
  let createNamespaceOpen = $state(false);
  let newNamespaceName = $state('');
  let newNamespaceDescription = $state('');
  let creating = $state(false);

  async function confirmCreateNamespace() {
    if (!newNamespaceName.trim()) return;
    creating = true;
    try {
      await createNamespace(newNamespaceName.trim(), newNamespaceDescription.trim() || undefined, `Created namespace ${newNamespaceName}`);
      notifications.success(`Created namespace ${newNamespaceName}`);
      createNamespaceOpen = false;
      newNamespaceName = '';
      newNamespaceDescription = '';
      await load();
    } catch (err) {
      notifications.error(err instanceof Error ? err.message : 'Failed to create namespace');
    } finally {
      creating = false;
    }
  }

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
          telemetryEnabled: ns.telemetryEnabled ?? false,
          selectedServerIds: ns.servers.map((server) => server.id),
          disabledTools: [...(nsPolicy?.disabledTools ?? [])],
          customInstructions: {
            compat: nsPolicy?.customInstructions?.compat ?? '',
            code: nsPolicy?.customInstructions?.code ?? '',
          },
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
      const customPayload: { compat?: string; code?: string } = {};
      const ct = draft.customInstructions.compat.trim();
      if (ct.length > 0 && ct !== currentNamespace.instructions.compat.defaultText) {
        customPayload.compat = ct;
      }
      const dt = draft.customInstructions.code.trim();
      if (dt.length > 0 && dt !== currentNamespace.instructions.code.defaultText) {
        customPayload.code = dt;
      }

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
            telemetryEnabled: draft.telemetryEnabled,
            disabledTools: draft.disabledTools,
            customInstructions: customPayload,
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
          const effectiveNamespaces =
            nextNamespaces.length > 0 ? nextNamespaces : ['default'];
          return updateConfigServer(server.id, { namespaces: effectiveNamespaces });
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
    <div class="flex items-center gap-2">
      <button
        onclick={() => (createNamespaceOpen = true)}
        disabled={loading}
        class="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
        Create Namespace
      </button>
      <button
        onclick={saveSelectedNamespace}
        disabled={!draft || saving || loading}
        class="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {saving ? 'Saving…' : 'Save Namespace'}
      </button>
    </div>
  </div>

  <div class="grid gap-6 xl:grid-cols-[320px_1fr]">
    <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <div class="flex items-center gap-2">
          <p class="text-sm font-semibold text-slate-900 dark:text-white">Namespace catalog</p>
          <InfoTooltip text="Token pills are tools/list only. Compat/code also send long initialize.instructions; when present, the line below shows first-turn estimate (tools/list + instructions). Server count is downstream servers assigned to the namespace." />
        </div>
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
                {namespace.metrics.toolCount} on tools/list · {namespace.metrics.serverCount} servers
                {#if namespace.metrics.initializeInstructionsTokens > 0}
                  <span class="block text-[11px] mt-0.5 text-slate-600 dark:text-slate-400">
                    ~{namespace.metrics.firstTurnEstimatedTokens} est. 1st turn (incl. init text)
                  </span>
                {/if}
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
            <div class="flex items-center gap-1 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Tools on tools/list
              <InfoTooltip text="Count of tools returned to the MCP client on tools/list after initialize (gateway mode affects this: default exposes downstream tools; compat exposes search/call/server discovery tools; code exposes gateway_run_code and gateway_help)." />
            </div>
            <p class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">{selectedNamespace.metrics.toolCount}</p>
          </div>
          <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <div class="flex items-center gap-1 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Schema tokens (tools/list)
              <InfoTooltip text="Estimated tokens from input schemas in the published tools/list payload (UTF-8 length ÷ 4)." />
            </div>
            <p class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">~{selectedNamespace.metrics.schemaTokens}</p>
          </div>
          <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <div class="flex items-center gap-1 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Avg tokens / tool (tools/list)
              <InfoTooltip text="mean total tokens per tool in the tools/list surface (not the full downstream catalog in compat/code)." />
            </div>
            <p class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">~{selectedNamespace.metrics.averageTokensPerTool}</p>
          </div>
          <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <div class="flex items-center gap-1 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Customized tools
              <InfoTooltip text="Downstream tools in this namespace with description/schema overrides (see Effective tools). Gateway meta-tools are not counted. In compat/code the tools/list window does not include downstream tools, but overrides still apply when those tools run." />
            </div>
            <p class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">{selectedNamespace.catalogMetrics.customizedTools}</p>
          </div>
        </div>

        {#if selectedNamespace.metrics.initializeInstructionsTokens > 0}
          <div class="grid gap-3 md:grid-cols-2">
            <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div class="flex items-center gap-1 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Initialize instructions (est.)
                <InfoTooltip text="Separate from tools/list: the instructions field on MCP initialize in compat/code (UTF-8 length ÷ 4). Uses custom text when set, otherwise the generated template." />
              </div>
              <p class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">
                ~{selectedNamespace.metrics.initializeInstructionsTokens}
              </p>
            </div>
            <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div class="flex items-center gap-1 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                First turn estimate
                <InfoTooltip text="tools/list token total plus initialize instructions — rough upper bound for what the client may surface right after connect (actual client handling varies)." />
              </div>
              <p class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">
                ~{selectedNamespace.metrics.firstTurnEstimatedTokens}
              </p>
            </div>
          </div>
        {/if}

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
              <InfoTooltip
                preserveLineBreaks
                text={
                  `Mode details:
• Default: Exposes all enabled downstream tools directly.
• Code: Exposes 2 tools — gateway_run_code and gateway_help. The agent will figure it out by itself (Recommended)
• Compat: Exposes 4 tools allowing the agent to explore and call other tools (Advanced workflows and settings).`
                }
              />
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

          {#if !defaultModeActive && selectedNamespace && draft}
            {@const mode = draft.gatewayMode === 'code' ? 'code' : 'compat'}
            {@const draftPart = mode === 'compat' ? draft.customInstructions.compat : draft.customInstructions.code}
            {@const defaultPart =
              mode === 'compat'
                ? selectedNamespace.instructions.compat.defaultText
                : selectedNamespace.instructions.code.defaultText}
            {@const editorValue = draftPart.trim().length > 0 ? draftPart : defaultPart}
            {@const showCustomBadge = draftPart.trim().length > 0}
            <div class="space-y-3">
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <div class="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
                  Initialize instructions ({mode})
                  <InfoTooltip
                    text={`Full MCP initialize instructions for the selected gateway mode. Use the ${INSTRUCTIONS_SERVERS_PLACEHOLDER} token anywhere in custom text: it is replaced at connect time with the current downstream server IDs (same JSON-array shape as the default template). Reset restores the generated default.`}
                  />
                </div>
                <p class="text-xs text-amber-800/90 dark:text-amber-200/90">
                  Custom text replaces the built-in template—you can still embed {INSTRUCTIONS_SERVERS_PLACEHOLDER} for a live server list; keep tool-discovery guidance correct or use Reset.
                </p>
              </div>
              <div class="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3">
                <div class="flex items-center justify-between gap-2 flex-wrap">
                  <Badge variant={showCustomBadge ? 'info' : 'default'}>
                    {showCustomBadge ? 'Custom' : 'Default'}
                  </Badge>
                  <div class="flex items-center gap-3 flex-wrap">
                    <button
                      type="button"
                      onclick={() => {
                        const d = draft;
                        const ns = selectedNamespace;
                        if (!d || !ns) return;
                        const key = mode === 'compat' ? 'compat' : 'code';
                        const defaultTxt =
                          mode === 'compat' ? ns.instructions.compat.defaultText : ns.instructions.code.defaultText;
                        const draftTxt = mode === 'compat' ? d.customInstructions.compat : d.customInstructions.code;
                        const base = draftTxt.trim().length > 0 ? draftTxt : defaultTxt;
                        if (base.includes(INSTRUCTIONS_SERVERS_PLACEHOLDER)) return;
                        const line = `- Current downstream servers are ${INSTRUCTIONS_SERVERS_PLACEHOLDER}`;
                        d.customInstructions[key] =
                          base.trim().length > 0 ? `${base.trimEnd()}\n${line}` : line;
                      }}
                      class="text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline"
                    >
                      Insert server list ({INSTRUCTIONS_SERVERS_PLACEHOLDER})
                    </button>
                    <button
                      type="button"
                      onclick={() => {
                        const d = draft;
                        if (!d) return;
                        if (mode === 'compat') d.customInstructions.compat = '';
                        else d.customInstructions.code = '';
                      }}
                      class="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      Reset to default
                    </button>
                  </div>
                </div>
                <div class="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                  {#key `${selectedNamespaceKey}-${mode}`}
                    <DescriptionEditor
                      value={editorValue}
                      placeholder={`Initialize instructions (${mode} mode)`}
                      scrollerMinHeight="12rem"
                      oninput={(val) => {
                        if (!draft) return;
                        if (mode === 'compat') draft.customInstructions.compat = val;
                        else draft.customInstructions.code = val;
                      }}
                    />
                  {/key}
                </div>
              </div>
            </div>
          {/if}

          <div class="space-y-3">
            <div class="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
              Telemetry estimates
              <InfoTooltip text="Opt-in per namespace. When enabled, the gateway estimates latency, payload size, and token usage for tool calls. Code and compat can return this telemetry to the client; default mode mainly uses it in logs and admin-side metrics." />
            </div>
            <div class="flex items-center justify-between gap-4 rounded-xl border border-slate-200 dark:border-slate-800 px-4 py-3">
              <div class="space-y-1">
                <p class="text-sm font-medium text-slate-900 dark:text-white">Enable telemetry estimates</p>
                <p class="text-xs text-slate-500 dark:text-slate-400">Disabled by default. When off, the gateway skips token estimation entirely for this namespace.</p>
              </div>
              <Switch
                checked={draft.telemetryEnabled}
                ariaLabel={`Enable telemetry estimates for namespace ${selectedNamespace.key}`}
                onchange={(next) => {
                  if (draft) draft.telemetryEnabled = next;
                }}
              />
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
              <InfoTooltip text="Server assignment controls which downstream tools appear in this namespace catalog (and default-mode tools/list). In compat/code, meta-tools still search/call this catalog." />
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
              <InfoTooltip text="Downstream catalog for this namespace: token estimates use name, description, and input schema after overrides (not the compat/code tools/list window). Row switches exclude a tool from this namespace (saved with Save Namespace)." />
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

<Modal open={createNamespaceOpen} title="Create namespace" onclose={() => (createNamespaceOpen = false)}>
  <div class="space-y-4">
    <div class="space-y-2">
      <label for="ns-name" class="block text-sm font-medium text-slate-700 dark:text-slate-300">Name</label>
      <input
        id="ns-name"
        type="text"
        bind:value={newNamespaceName}
        placeholder="e.g. my-namespace"
        autocomplete="off"
        class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 transition-colors"
      />
      <p class="text-xs text-slate-500 dark:text-slate-400">Must start with a letter and contain only lowercase letters, numbers, hyphens, and underscores.</p>
    </div>
    <div class="space-y-2">
      <label for="ns-desc" class="block text-sm font-medium text-slate-700 dark:text-slate-300">Description (optional)</label>
      <textarea
        id="ns-desc"
        bind:value={newNamespaceDescription}
        placeholder="A brief description of this namespace"
        rows="3"
        class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 resize-none transition-colors"
      ></textarea>
    </div>
  </div>
  {#snippet footer()}
    <button
      type="button"
      onclick={() => (createNamespaceOpen = false)}
      class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
    >
      Cancel
    </button>
    <button
      type="button"
      onclick={confirmCreateNamespace}
      disabled={creating || !newNamespaceName.trim()}
      class="px-4 py-2 text-sm font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
    >
      {creating ? 'Creating…' : 'Create'}
    </button>
  {/snippet}
</Modal>

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
