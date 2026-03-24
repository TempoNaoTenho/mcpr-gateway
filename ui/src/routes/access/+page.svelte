<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import {
    ApiError,
    createAuthToken,
    deleteAuthToken,
    getAuthTokens,
    getConfig,
    getConfigServers,
    getPolicies,
    savePolicies,
    updateAuthToken,
    updateConfigServer,
    type AuthSummary,
    type AuthTokenConfig,
    type ConfigServer,
    type PoliciesConfig,
  } from '$lib/api.js';
  import { notifications } from '$lib/stores/notifications.js';
  import InfoTooltip from '../../components/ui/InfoTooltip.svelte';
  import Badge from '../../components/ui/Badge.svelte';
  import Modal from '../../components/ui/Modal.svelte';

  // ── Types ────────────────────────────────────────────────────────────────────

  type NamespaceRow = {
    key: string;
    allowedRoles: string[];
    bootstrapWindowSize: number;
    candidatePoolSize: number;
    allowedModes: string[];
  };

  type RoleRow = {
    key: string;
    allowNamespaces: string[];
    denyModes: string[];
  };

  type TokenRow = {
    token: string;
    userId: string;
    roles: string[];
  };

  const ALL_MODES = ['read', 'write', 'admin'];

  // ── State ────────────────────────────────────────────────────────────────────

  let loading = $state(true);
  let saving = $state(false);
  let tokenSaving = $state(false);
  let configSource = $state<'db' | 'file'>('file');
  let authSummary = $state<AuthSummary>({
    clientAuth: 'bearer_tokens',
    clientTokensConfigured: 0,
    adminTokenConfigured: false,
    devModeEnabled: false,
  });
  let namespaces = $state<NamespaceRow[]>([]);
  let roles = $state<RoleRow[]>([]);
  let authTokens = $state<TokenRow[]>([]);
  let advanced = $state<PoliciesConfig | null>(null);
  let selectedRoleIndex = $state(0);
  let activeTab = $state<'profiles' | 'namespaces' | 'tokens'>('profiles');

  // Token creation
  let newTokenUserId = $state('');
  let newTokenRoles = $state<string[]>([]);
  let latestCreatedToken = $state<string | null>(null);

  // Namespace editing
  let editingNamespaceIndex = $state<number | null>(null);

  // Token editing
  let editingToken = $state<{ token: string; userId: string; roles: string[] } | null>(null);

  // Confirmation modal
  let confirmAction = $state<{
    title: string;
    message: string;
    variant: 'danger' | 'warning';
    onConfirm: () => void;
  } | null>(null);

  // Server assignment
  let configServers = $state<ConfigServer[]>([]);
  let assignServerTarget = $state<{ namespaceKey: string } | null>(null);
  let assignServerIds = $state<string[]>([]);

  // ── Load ─────────────────────────────────────────────────────────────────────

  function toTokenRows(tokens: AuthTokenConfig[]): TokenRow[] {
    return tokens.map((t) => ({ token: t.token, userId: t.userId, roles: [...t.roles] }));
  }

  function loadPoliciesIntoState(policies: PoliciesConfig, tokens: AuthTokenConfig[]) {
    advanced = policies;
    namespaces = Object.entries(policies.namespaces).map(([key, v]) => ({
      key,
      allowedRoles: [...v.allowedRoles],
      bootstrapWindowSize: v.bootstrapWindowSize,
      candidatePoolSize: v.candidatePoolSize,
      allowedModes: [...v.allowedModes],
    }));
    roles = Object.entries(policies.roles).map(([key, v]) => ({
      key,
      allowNamespaces: [...v.allowNamespaces],
      denyModes: [...(v.denyModes ?? [])],
    }));
    authTokens = toTokenRows(tokens);
    selectedRoleIndex = 0;
  }

  async function load() {
    loading = true;
    try {
      const [policies, configRes, tokenRes, serversRes] = await Promise.all([getPolicies(), getConfig(), getAuthTokens(), getConfigServers()]);
      authSummary = tokenRes.summary ?? configRes.auth?.summary ?? authSummary;
      configSource = configRes.source === 'db' ? 'db' : 'file';
      loadPoliciesIntoState(policies, tokenRes.tokens);
      configServers = serversRes.servers;
    } catch {
      notifications.error('Failed to load access settings');
    } finally {
      loading = false;
    }
  }

  // ── Derived ──────────────────────────────────────────────────────────────────

  const selectedRole = $derived(roles[selectedRoleIndex] ?? null);

  const serversByNamespace = $derived(
    new Map(
      namespaces.map((ns) => [
        ns.key.trim(),
        configServers.filter((s) => s.namespaces.includes(ns.key.trim())),
      ]),
    ),
  );

  const serversForAssign = $derived(
    assignServerTarget
      ? configServers.filter((s) => !s.namespaces.includes(assignServerTarget!.namespaceKey))
      : [],
  );

  const profileNames = $derived(new Set(roles.map((r) => r.key.trim()).filter(Boolean)));
  const namespaceNames = $derived(new Set(namespaces.map((n) => n.key.trim()).filter(Boolean)));

  const profileRows = $derived(
    roles.map((role, index) => {
      const name = role.key.trim();
      const tokenCount = authTokens.filter((t) => t.roles.includes(name)).length;
      const activeNamespaces = namespaces
        .filter((ns) => {
          const nsKey = ns.key.trim();
          return role.allowNamespaces.includes(nsKey) && ns.allowedRoles.includes(name);
        })
        .map((ns) => ns.key.trim());

      return { index, name, blockedActions: role.denyModes, namespaces: activeNamespaces, tokenCount };
    }),
  );

  function resolveTokenAccess(token: TokenRow) {
    const knownRoles = token.roles.filter((r) => profileNames.has(r));
    const blockedActions = [...new Set(
      roles.filter((r) => knownRoles.includes(r.key.trim())).flatMap((r) => r.denyModes),
    )];
    const resolvedNamespaces = namespaces
      .filter((ns) => {
        const nsKey = ns.key.trim();
        return roles.some((r) => {
          const rKey = r.key.trim();
          return knownRoles.includes(rKey) && r.allowNamespaces.includes(nsKey) && ns.allowedRoles.includes(rKey);
        });
      })
      .map((ns) => ns.key.trim());

    return { knownRoles, blockedActions, resolvedNamespaces };
  }

  // ── Per-entity warnings ──────────────────────────────────────────────────────

  const profileWarnings = $derived(
    new Map(
      roles.map((r) => {
        const warnings: string[] = [];
        const name = r.key.trim();
        for (const ns of r.allowNamespaces) {
          if (!namespaceNames.has(ns)) {
            warnings.push(`References missing namespace: ${ns}`);
          } else {
            const nsObj = namespaces.find((n) => n.key.trim() === ns);
            if (nsObj && !nsObj.allowedRoles.includes(name)) {
              warnings.push(`${ns} does not allow this profile`);
            }
          }
        }
        return [name, warnings] as const;
      }),
    ),
  );

  const tokenWarnings = $derived(
    new Map(
      authTokens.map((t) => {
        const warnings: string[] = [];
        for (const role of t.roles) {
          if (!profileNames.has(role)) warnings.push(`Missing profile: ${role}`);
        }
        const resolved = resolveTokenAccess(t);
        if (resolved.knownRoles.length === 0 && t.roles.length > 0) warnings.push('No valid profiles');
        else if (resolved.resolvedNamespaces.length === 0 && resolved.knownRoles.length > 0) warnings.push('No namespace access');
        return [t.token, warnings] as const;
      }),
    ),
  );

  // ── Validation ───────────────────────────────────────────────────────────────

  function formatApiError(err: unknown, fallback: string): string {
    if (err instanceof ApiError && err.issues && err.issues.length > 0) {
      return err.issues.map((i) => i.message).join(' ');
    }
    return err instanceof Error ? err.message : fallback;
  }

  function validateBeforeSave(): boolean {
    const pNames = new Set(roles.map((r) => r.key.trim()).filter(Boolean));
    const nsNames = new Set(namespaces.map((n) => n.key.trim()).filter(Boolean));

    // Unique names (hard block — can't auto-fix)
    const profileKeys = roles.map((r) => r.key.trim()).filter(Boolean);
    if (new Set(profileKeys).size !== profileKeys.length) {
      notifications.error('Profile names must be unique');
      return false;
    }
    const nsKeys = namespaces.map((n) => n.key.trim()).filter(Boolean);
    if (new Set(nsKeys).size !== nsKeys.length) {
      notifications.error('Namespace names must be unique');
      return false;
    }

    // Auto-clean: strip invalid profile refs from namespaces
    let cleaned = 0;
    for (const ns of namespaces) {
      const before = ns.allowedRoles.length;
      ns.allowedRoles = ns.allowedRoles.filter((r) => pNames.has(r));
      cleaned += before - ns.allowedRoles.length;
    }

    // Auto-clean: strip invalid namespace refs from profiles
    for (const role of roles) {
      const before = role.allowNamespaces.length;
      role.allowNamespaces = role.allowNamespaces.filter((ns) => nsNames.has(ns));
      cleaned += before - role.allowNamespaces.length;
    }

    if (cleaned > 0) {
      notifications.info(`Cleaned ${cleaned} invalid reference(s) before saving`);
    }

    return true;
  }

  // ── Profile operations ───────────────────────────────────────────────────────

  function addRole() {
    roles = [...roles, { key: `profile-${roles.length + 1}`, allowNamespaces: [], denyModes: [] }];
    selectedRoleIndex = roles.length - 1;
  }

  function renameRole(index: number, nextValue: string) {
    const previous = roles[index]?.key.trim();
    const next = nextValue.trim();
    roles[index].key = nextValue;

    if (!previous || previous === next) return;

    for (const ns of namespaces) {
      ns.allowedRoles = ns.allowedRoles.map((r) => (r === previous ? next : r)).filter(Boolean);
    }
    for (const t of authTokens) {
      t.roles = t.roles.map((r) => (r === previous ? next : r)).filter(Boolean);
    }
  }

  function requestRemoveRole(index: number) {
    const name = roles[index]?.key.trim();
    if (!name) {
      roles = roles.filter((_, i) => i !== index);
      selectedRoleIndex = Math.max(0, Math.min(selectedRoleIndex, roles.length - 2));
      return;
    }

    const nsRefs = namespaces.filter((ns) => ns.allowedRoles.includes(name)).length;
    const tokenRefs = authTokens.filter((t) => t.roles.includes(name)).length;

    if (nsRefs > 0 || tokenRefs > 0) {
      confirmAction = {
        title: 'Remove Profile',
        message: `Profile "${name}" is referenced by ${nsRefs} namespace(s) and ${tokenRefs} token(s). Remove all references and delete this profile?`,
        variant: 'danger',
        onConfirm: () => {
          for (const ns of namespaces) {
            ns.allowedRoles = ns.allowedRoles.filter((r) => r !== name);
          }
          for (const t of authTokens) {
            t.roles = t.roles.filter((r) => r !== name);
          }
          roles = roles.filter((_, i) => i !== index);
          selectedRoleIndex = Math.max(0, Math.min(selectedRoleIndex, roles.length - 2));
          confirmAction = null;
        },
      };
    } else {
      roles = roles.filter((_, i) => i !== index);
      selectedRoleIndex = Math.max(0, Math.min(selectedRoleIndex, roles.length - 2));
    }
  }

  function toggleDenyMode(mode: string) {
    if (!selectedRole) return;
    if (selectedRole.denyModes.includes(mode)) {
      selectedRole.denyModes = selectedRole.denyModes.filter((m) => m !== mode);
    } else {
      selectedRole.denyModes = [...selectedRole.denyModes, mode];
    }
  }

  function setNamespaceMembership(roleIndex: number, nsKey: string, enabled: boolean) {
    const role = roles[roleIndex];
    const ns = namespaces.find((n) => n.key.trim() === nsKey);
    if (!role || !ns) return;

    const profileName = role.key.trim();
    if (!profileName) {
      notifications.error('Set the profile name before assigning namespaces');
      return;
    }

    if (enabled) {
      if (!role.allowNamespaces.includes(nsKey)) role.allowNamespaces = [...role.allowNamespaces, nsKey];
      if (!ns.allowedRoles.includes(profileName)) ns.allowedRoles = [...ns.allowedRoles, profileName];
    } else {
      role.allowNamespaces = role.allowNamespaces.filter((n) => n !== nsKey);
      ns.allowedRoles = ns.allowedRoles.filter((r) => r !== profileName);
    }
  }

  // ── Namespace operations ─────────────────────────────────────────────────────

  function addNamespace() {
    const fallbackRole = selectedRole?.key.trim() || roles[0]?.key.trim() || '';
    const newNs: NamespaceRow = {
      key: `namespace-${namespaces.length + 1}`,
      allowedRoles: fallbackRole ? [fallbackRole] : [],
      bootstrapWindowSize: 4,
      candidatePoolSize: 16,
      allowedModes: ['read', 'write'],
    };
    namespaces = [...namespaces, newNs];

    // Bidirectional: also add namespace to the fallback role
    if (fallbackRole) {
      const role = roles.find((r) => r.key.trim() === fallbackRole);
      if (role && !role.allowNamespaces.includes(newNs.key)) {
        role.allowNamespaces = [...role.allowNamespaces, newNs.key];
      }
    }

    editingNamespaceIndex = namespaces.length - 1;
    activeTab = 'namespaces';
  }

  function renameNamespace(index: number, nextValue: string) {
    const previous = namespaces[index]?.key.trim();
    const next = nextValue.trim();
    namespaces[index].key = nextValue;

    if (!previous || previous === next) return;

    for (const role of roles) {
      role.allowNamespaces = role.allowNamespaces.map((n) => (n === previous ? next : n)).filter(Boolean);
    }
  }

  function requestRemoveNamespace(index: number) {
    const nsKey = namespaces[index]?.key.trim();
    if (!nsKey) {
      namespaces = namespaces.filter((_, i) => i !== index);
      if (editingNamespaceIndex === index) editingNamespaceIndex = null;
      return;
    }

    const profilesUsing = roles.filter((r) => r.allowNamespaces.includes(nsKey)).map((r) => r.key.trim());
    const tokensAffected = authTokens.filter((t) => t.roles.some((r) => profilesUsing.includes(r)));

    if (tokensAffected.length > 0) {
      confirmAction = {
        title: 'Remove Namespace',
        message: `Namespace "${nsKey}" is used by ${profilesUsing.length} profile(s) and ${tokensAffected.length} token(s) will lose access. Continue?`,
        variant: 'warning',
        onConfirm: () => {
          for (const role of roles) {
            role.allowNamespaces = role.allowNamespaces.filter((n) => n !== nsKey);
          }
          namespaces = namespaces.filter((_, i) => i !== index);
          if (editingNamespaceIndex === index) editingNamespaceIndex = null;
          confirmAction = null;
        },
      };
    } else {
      for (const role of roles) {
        role.allowNamespaces = role.allowNamespaces.filter((n) => n !== nsKey);
      }
      namespaces = namespaces.filter((_, i) => i !== index);
      if (editingNamespaceIndex === index) editingNamespaceIndex = null;
    }
  }

  function toggleNamespaceMode(index: number, mode: string) {
    const ns = namespaces[index];
    if (!ns) return;
    if (ns.allowedModes.includes(mode)) {
      ns.allowedModes = ns.allowedModes.filter((m) => m !== mode);
    } else {
      ns.allowedModes = [...ns.allowedModes, mode];
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────────

  async function save() {
    if (!advanced) return;
    if (!validateBeforeSave()) return;

    saving = true;
    try {
      const next: PoliciesConfig = {
        ...advanced,
        namespaces: Object.fromEntries(
          namespaces.filter((r) => r.key.trim()).map((r) => {
            const key = r.key.trim();
            const prev = advanced?.namespaces[key];
            return [
              key,
              {
                ...prev,
                allowedRoles: r.allowedRoles,
                bootstrapWindowSize: Number(r.bootstrapWindowSize),
                candidatePoolSize: Number(r.candidatePoolSize),
                allowedModes: r.allowedModes,
                gatewayMode: prev?.gatewayMode ?? 'compat',
                disabledTools: prev?.disabledTools ?? [],
              },
            ];
          }),
        ),
        roles: Object.fromEntries(
          roles.filter((r) => r.key.trim()).map((r) => [
            r.key.trim(),
            { allowNamespaces: r.allowNamespaces, denyModes: r.denyModes },
          ]),
        ),
      };

      await savePolicies(next, 'Updated access control');
      notifications.success('Access rules updated');
      await load();
    } catch (err) {
      notifications.error(formatApiError(err, 'Failed to save access control'));
    } finally {
      saving = false;
    }
  }

  // ── Server assignment ─────────────────────────────────────────────────────────

  async function assignServerToNamespace() {
    if (!assignServerTarget || assignServerIds.length === 0) return;
    const nsKey = assignServerTarget.namespaceKey;
    try {
      await Promise.all(
        assignServerIds.map((id) => {
          const server = configServers.find((s) => s.id === id);
          const current = server?.namespaces ?? [];
          const next = current.includes(nsKey) ? current : [...current, nsKey];
          return updateConfigServer(id, { namespaces: next });
        }),
      );
      for (const id of assignServerIds) {
        const idx = configServers.findIndex((s) => s.id === id);
        if (idx >= 0) {
          const current = configServers[idx].namespaces;
          configServers[idx] = {
            ...configServers[idx],
            namespaces: current.includes(nsKey) ? current : [...current, nsKey],
          };
        }
      }
      const count = assignServerIds.length;
      notifications.success(`${count} server${count === 1 ? '' : 's'} added to ${nsKey}`);
    } catch {
      notifications.error('Failed to assign servers');
    } finally {
      assignServerTarget = null;
      assignServerIds = [];
    }
  }

  // ── Token operations ─────────────────────────────────────────────────────────

  async function createToken() {
    if (!newTokenUserId.trim()) {
      notifications.error('User ID is required');
      return;
    }
    if (newTokenRoles.length === 0) {
      notifications.error('At least one permission profile is required');
      return;
    }

    tokenSaving = true;
    try {
      const created = await createAuthToken({ userId: newTokenUserId.trim(), roles: newTokenRoles });
      latestCreatedToken = created.token;
      newTokenUserId = '';
      newTokenRoles = [];
      notifications.success('Client access token created');
      const refreshed = await getAuthTokens();
      authSummary = refreshed.summary;
      authTokens = toTokenRows(refreshed.tokens);
    } catch (err) {
      notifications.error(formatApiError(err, 'Failed to create client access token'));
    } finally {
      tokenSaving = false;
    }
  }

  function openEditToken(t: TokenRow) {
    editingToken = { token: t.token, userId: t.userId, roles: [...t.roles] };
  }

  async function saveEditingToken() {
    if (!editingToken) return;
    if (!editingToken.userId.trim() || editingToken.roles.length === 0) {
      notifications.error('User ID and at least one profile are required');
      return;
    }

    tokenSaving = true;
    try {
      await updateAuthToken(editingToken.token, {
        userId: editingToken.userId.trim(),
        roles: editingToken.roles,
      });
      editingToken = null;
      notifications.success('Client access token updated');
      const refreshed = await getAuthTokens();
      authSummary = refreshed.summary;
      authTokens = toTokenRows(refreshed.tokens);
    } catch (err) {
      notifications.error(formatApiError(err, 'Failed to update client access token'));
    } finally {
      tokenSaving = false;
    }
  }

  function requestRevokeToken(token: string, userId: string) {
    confirmAction = {
      title: 'Revoke Token',
      message: `Revoke the access token for "${userId}"? This action cannot be undone.`,
      variant: 'danger',
      onConfirm: async () => {
        confirmAction = null;
        tokenSaving = true;
        try {
          await deleteAuthToken(token);
          if (latestCreatedToken === token) latestCreatedToken = null;
          notifications.success('Client access token revoked');
          const refreshed = await getAuthTokens();
          authSummary = refreshed.summary;
          authTokens = toTokenRows(refreshed.tokens);
        } catch (err) {
          notifications.error(formatApiError(err, 'Failed to revoke token'));
        } finally {
          tokenSaving = false;
        }
      },
    };
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      notifications.success(`${label} copied`);
    } catch {
      notifications.error(`Failed to copy ${label.toLowerCase()}`);
    }
  }

  function toggleNewTokenRole(role: string) {
    if (newTokenRoles.includes(role)) {
      newTokenRoles = newTokenRoles.filter((r) => r !== role);
    } else {
      newTokenRoles = [...newTokenRoles, role];
    }
  }

  function toggleEditTokenRole(role: string) {
    if (!editingToken) return;
    if (editingToken.roles.includes(role)) {
      editingToken.roles = editingToken.roles.filter((r) => r !== role);
    } else {
      editingToken.roles = [...editingToken.roles, role];
    }
  }

  onMount(load);
</script>

<svelte:head>
  <title>Access Control — MCP Gateway</title>
</svelte:head>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between gap-3">
    <div class="flex items-center gap-1.5">
      <h1 class="text-xl font-semibold text-slate-900 dark:text-white">Access Policy Studio</h1>
      <InfoTooltip text="Manage profiles, namespaces, and client tokens. Access is granted only when the token's profile and the namespace both agree." />
    </div>
      <div class="flex items-center gap-3">
        <a
          href={`${base}/namespaces`}
          class="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          Open Namespaces
        </a>
        <button onclick={save} disabled={saving || loading} class="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 transition-colors">
          {saving ? 'Saving…' : 'Save Access Policy'}
        </button>
      </div>
  </div>

  <!-- Summary cards -->
  <div class="grid gap-3 md:grid-cols-4">
    <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div class="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Client tokens
        <InfoTooltip text="Persisted bearer tokens accepted on /mcp/:namespace." />
      </div>
      <div class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">{authSummary.clientTokensConfigured}</div>
    </div>
    <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div class="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Profiles
        <InfoTooltip text="Profiles define namespace access and blocked action modes." />
      </div>
      <div class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">{roles.length}</div>
    </div>
    <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div class="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Namespaces
        <InfoTooltip text="Each namespace keeps its own tool windows and allowed actions." />
      </div>
      <div class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">{namespaces.length}</div>
    </div>
    <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div class="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Runtime
        <InfoTooltip text="Where the config is persisted and whether the admin panel is protected." />
      </div>
      <div class="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{configSource === 'db' ? 'SQLite' : 'bootstrap.json'} · {authSummary.adminTokenConfigured ? 'Admin protected' : 'Admin open'}</div>
    </div>
  </div>

  {#if authSummary.devModeEnabled}
    <div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
      mock_dev bootstrap fallback is enabled. Persisted client tokens still win over ad-hoc dev Bearer values.
    </div>
  {/if}

  <!-- Tab bar -->
  <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
    <div class="flex border-b border-slate-200 dark:border-slate-800">
      <button
        onclick={() => (activeTab = 'profiles')}
        class="px-5 py-3 text-sm font-medium transition-colors {activeTab === 'profiles' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
      >
        Profiles
      </button>
      <button
        onclick={() => (activeTab = 'tokens')}
        class="px-5 py-3 text-sm font-medium transition-colors {activeTab === 'tokens' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
      >
        Client Tokens
      </button>
    </div>

    <div class="p-5">
      <!-- ═══════════════════════ PROFILES TAB ═══════════════════════ -->
      {#if activeTab === 'profiles'}
        <div class="grid gap-6 xl:grid-cols-[1.1fr_1.9fr]">
          <!-- Profile list -->
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
                Permission Profiles
                <InfoTooltip text="Each profile defines which namespaces it can access and which action modes are blocked." />
              </div>
              <button onclick={addRole} class="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">Add Profile</button>
            </div>

            <div class="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
              <table class="w-full text-sm">
                <thead class="bg-slate-50 dark:bg-slate-950/40">
                  <tr>
                    <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Profile</th>
                    <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Namespaces</th>
                    <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Tokens</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                  {#if loading}
                    <tr><td colspan="3" class="px-4 py-8 text-center text-slate-500 dark:text-slate-400">Loading…</td></tr>
                  {:else if profileRows.length === 0}
                    <tr><td colspan="3" class="px-4 py-8 text-center text-slate-500 dark:text-slate-400">No profiles configured.</td></tr>
                  {:else}
                    {#each profileRows as row}
                      {@const warnings = profileWarnings.get(row.name) ?? []}
                      <tr
                        class="cursor-pointer transition-colors {selectedRoleIndex === row.index ? 'bg-indigo-50 dark:bg-indigo-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'}"
                        onclick={() => (selectedRoleIndex = row.index)}
                      >
                        <td class="px-4 py-3">
                          <div class="flex items-center gap-2">
                            <span class="font-medium text-slate-900 dark:text-white">{row.name || '(unnamed)'}</span>
                            {#if warnings.length > 0}
                              <span class="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="{warnings.join('; ')}"></span>
                            {/if}
                          </div>
                          {#if row.blockedActions.length > 0}
                            <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Blocked: {row.blockedActions.join(', ')}</div>
                          {/if}
                        </td>
                        <td class="px-4 py-3 text-slate-700 dark:text-slate-300">{row.namespaces.length}</td>
                        <td class="px-4 py-3 text-slate-700 dark:text-slate-300">{row.tokenCount}</td>
                      </tr>
                    {/each}
                  {/if}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Detail panel -->
          <div class="space-y-4">
            <div class="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
              Profile Workspace
              <InfoTooltip text="Edit the selected profile's settings and namespace memberships." />
            </div>

            {#if !selectedRole}
              <div class="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 px-4 py-8 text-sm text-slate-500 dark:text-slate-400 text-center">
                Add a profile to start building assignments.
              </div>
            {:else}
              <div class="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-5">
                <!-- Profile name + remove -->
                <div class="flex items-end gap-3">
                  <label class="flex-1 space-y-1">
                    <span class="text-xs font-medium text-slate-500 dark:text-slate-400">Profile name</span>
                    <input
                      value={selectedRole.key}
                      onchange={(e) => renameRole(selectedRoleIndex, e.currentTarget.value)}
                      class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                    />
                  </label>
                  <button
                    onclick={() => requestRemoveRole(selectedRoleIndex)}
                    class="px-3 py-2 text-xs rounded-lg border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                  >
                    Remove Profile
                  </button>
                </div>

                <!-- Blocked actions (checkbox group) -->
                <div class="space-y-2">
                  <div class="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                    Blocked actions
                    <InfoTooltip text="Actions this profile is denied from performing, even if the namespace allows them." />
                  </div>
                  <div class="flex gap-3">
                    {#each ALL_MODES as mode}
                      <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                        <input
                          type="checkbox"
                          checked={selectedRole.denyModes.includes(mode)}
                          onchange={() => toggleDenyMode(mode)}
                          class="rounded border-slate-300 dark:border-slate-600"
                        />
                        {mode}
                      </label>
                    {/each}
                  </div>
                </div>

                <!-- Namespace assignment -->
                <div class="space-y-3">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                      Namespace Access
                      <InfoTooltip text="Checking a namespace updates both sides: the profile's allow list and the namespace's allowed profiles." />
                    </div>
                    <button onclick={addNamespace} class="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">Add Namespace</button>
                  </div>

                  {#if namespaces.length === 0}
                    <div class="text-sm text-slate-500 dark:text-slate-400">No namespaces configured.</div>
                  {:else}
                    <div class="rounded-xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                      {#each namespaces as ns, nsIndex}
                        {@const nsKey = ns.key.trim()}
                        {@const profileName = selectedRole.key.trim()}
                        {@const profileAllows = nsKey ? selectedRole.allowNamespaces.includes(nsKey) : false}
                        {@const nsAllows = profileName ? ns.allowedRoles.includes(profileName) : false}
                        {@const fullyActive = profileAllows && nsAllows}
                        {@const oneSided = (profileAllows || nsAllows) && !fullyActive}
                        <div class="flex items-center gap-3 px-4 py-3">
                          <input
                            type="checkbox"
                            checked={fullyActive}
                            onchange={(e) => setNamespaceMembership(selectedRoleIndex, nsKey, e.currentTarget.checked)}
                            disabled={!nsKey || !profileName}
                            class="rounded border-slate-300 dark:border-slate-600"
                          />
                          <span class="text-sm text-slate-900 dark:text-white font-medium">{nsKey || '(unnamed)'}</span>
                          {#if fullyActive}
                            <Badge variant="success">active</Badge>
                          {:else if oneSided}
                            <Badge variant="warning">one-sided</Badge>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>

                <!-- Profile warnings -->
                {#if (profileWarnings.get(selectedRole.key.trim()) ?? []).length > 0}
                  <div class="space-y-1">
                    {#each profileWarnings.get(selectedRole.key.trim()) ?? [] as w}
                      <div class="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                        <span class="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"></span>
                        {w}
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </div>

      <!-- ═══════════════════════ NAMESPACES TAB ═══════════════════════ -->
      {:else if activeTab === 'namespaces'}
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
              Namespaces
              <InfoTooltip text="Namespaces group servers and define tool window sizes and allowed actions." />
            </div>
            <button onclick={addNamespace} class="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">Add Namespace</button>
          </div>

          {#if loading}
            <div class="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">Loading…</div>
          {:else if namespaces.length === 0}
            <div class="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 px-4 py-8 text-sm text-slate-500 dark:text-slate-400 text-center">
              No namespaces configured.
            </div>
          {:else}
            <div class="space-y-3">
              {#each namespaces as ns, index}
                {@const isEditing = editingNamespaceIndex === index}
                {@const assignedProfiles = roles.filter((r) => r.allowNamespaces.includes(ns.key.trim()) && ns.allowedRoles.includes(r.key.trim())).map((r) => r.key.trim())}
                <div class="rounded-xl border border-slate-200 dark:border-slate-800 transition-all {isEditing ? 'ring-2 ring-indigo-500/20' : ''}">
                  <!-- Row header -->
                  <button
                    type="button"
                    class="w-full flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors text-left"
                    onclick={() => (editingNamespaceIndex = isEditing ? null : index)}
                  >
                    <div class="flex items-center gap-3 min-w-0">
                      <span class="font-medium text-sm text-slate-900 dark:text-white">{ns.key.trim() || '(unnamed)'}</span>
                      <div class="flex gap-1.5 flex-wrap">
                        {#each ns.allowedModes as mode}
                          <Badge variant="default">{mode}</Badge>
                        {/each}
                      </div>
                    </div>
                    <div class="flex items-center gap-3">
                      <div class="flex gap-1 flex-wrap">
                        {#each assignedProfiles as p}
                          <Badge variant="info">{p}</Badge>
                        {/each}
                        {#if assignedProfiles.length === 0}
                          <Badge variant="warning">no profiles</Badge>
                        {/if}
                      </div>
                      <svg class="w-4 h-4 text-slate-400 transition-transform {isEditing ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                    </div>
                  </button>

                  <!-- Expanded edit panel -->
                  {#if isEditing}
                    <div class="border-t border-slate-200 dark:border-slate-800 p-4 space-y-4">
                      <div class="grid gap-3 md:grid-cols-2">
                        <label class="space-y-1">
                          <span class="text-xs font-medium text-slate-500 dark:text-slate-400">Namespace name</span>
                          <input
                            value={ns.key}
                            onchange={(e) => renameNamespace(index, e.currentTarget.value)}
                            class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                          />
                        </label>
                        <div class="space-y-1">
                          <span class="text-xs font-medium text-slate-500 dark:text-slate-400">Allowed actions</span>
                          <div class="flex gap-3 pt-1.5">
                            {#each ALL_MODES as mode}
                              <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={ns.allowedModes.includes(mode)}
                                  onchange={() => toggleNamespaceMode(index, mode)}
                                  class="rounded border-slate-300 dark:border-slate-600"
                                />
                                {mode}
                              </label>
                            {/each}
                          </div>
                        </div>
                      </div>

                      <!-- Assigned profiles (read-only) -->
                      <div class="space-y-1">
                        <span class="text-xs font-medium text-slate-500 dark:text-slate-400">Assigned profiles</span>
                        <div class="flex gap-1.5 flex-wrap">
                          {#each ns.allowedRoles as role}
                            {@const exists = profileNames.has(role)}
                            <Badge variant={exists ? 'info' : 'danger'}>{role}{exists ? '' : ' (missing)'}</Badge>
                          {/each}
                          {#if ns.allowedRoles.length === 0}
                            <span class="text-xs text-slate-400">None — assign via the Profiles tab.</span>
                          {/if}
                        </div>
                      </div>

                      <!-- Servers in this namespace -->
                      <div class="space-y-2">
                        <div class="flex items-center justify-between">
                          <span class="text-xs font-medium text-slate-500 dark:text-slate-400">Servers</span>
                          <button
                            onclick={() => { assignServerTarget = { namespaceKey: ns.key.trim() }; assignServerIds = []; }}
                            class="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                          >
                            + Assign Server
                          </button>
                        </div>
                        <div class="flex gap-1.5 flex-wrap">
                          {#each serversByNamespace.get(ns.key.trim()) ?? [] as server}
                            <Badge variant="default">{server.id}</Badge>
                          {/each}
                          {#if (serversByNamespace.get(ns.key.trim()) ?? []).length === 0}
                            <span class="text-xs text-slate-400">No servers assigned to this namespace.</span>
                          {/if}
                        </div>
                      </div>

                      <!-- Advanced: window sizes -->
                      <details class="group">
                        <summary class="text-xs font-medium text-slate-500 dark:text-slate-400 cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-300">
                          Advanced — tool window sizes
                        </summary>
                        <div class="grid gap-3 md:grid-cols-2 mt-3">
                          <label class="space-y-1">
                            <div class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                              Bootstrap window
                              <InfoTooltip text="Number of tools available when first opening the namespace." />
                            </div>
                            <input type="number" bind:value={ns.bootstrapWindowSize} min="1" class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
                          </label>
                          <label class="space-y-1">
                            <div class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                              Candidate pool
                              <InfoTooltip text="Size of the candidate tool pool for selection." />
                            </div>
                            <input type="number" bind:value={ns.candidatePoolSize} min="1" class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
                          </label>
                        </div>
                      </details>

                      <div class="flex justify-end">
                        <button
                          onclick={() => requestRemoveNamespace(index)}
                          class="px-3 py-2 text-xs rounded-lg border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                        >
                          Remove Namespace
                        </button>
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>

      <!-- ═══════════════════════ TOKENS TAB ═══════════════════════ -->
      {:else if activeTab === 'tokens'}
        <div class="space-y-5">
          <!-- Create token form -->
          <div class="space-y-4">
            <div class="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
              New Token
              <InfoTooltip text="Generate a bearer token for API clients. Select which profiles to assign." />
            </div>

            <div class="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-4">
              <label class="block space-y-1">
                <span class="text-xs font-medium text-slate-500 dark:text-slate-400">User ID</span>
                <input bind:value={newTokenUserId} placeholder="alice" class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 max-w-sm" />
              </label>

              <div class="space-y-2">
                <span class="text-xs font-medium text-slate-500 dark:text-slate-400">Permission profiles</span>
                {#if roles.length === 0}
                  <div class="text-xs text-slate-400">No profiles available — create one in the Profiles tab first.</div>
                {:else}
                  <div class="flex gap-3 flex-wrap">
                    {#each roles as role}
                      {@const name = role.key.trim()}
                      {#if name}
                        <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                          <input
                            type="checkbox"
                            checked={newTokenRoles.includes(name)}
                            onchange={() => toggleNewTokenRole(name)}
                            class="rounded border-slate-300 dark:border-slate-600"
                          />
                          {name}
                        </label>
                      {/if}
                    {/each}
                  </div>
                {/if}
              </div>

              <button
                onclick={createToken}
                disabled={tokenSaving || loading}
                class="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-50 transition-colors"
              >
                {tokenSaving ? 'Working…' : 'Generate Token'}
              </button>
            </div>
          </div>

          {#if latestCreatedToken}
            <div class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200 space-y-2">
              <div class="font-medium">New client token generated</div>
              <div class="flex flex-col gap-3 md:flex-row md:items-center">
                <code class="font-mono break-all">{latestCreatedToken}</code>
                <button onclick={() => latestCreatedToken && copyText(latestCreatedToken, 'Client access token')} class="px-3 py-1.5 text-xs rounded-lg border border-emerald-400 dark:border-emerald-700 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors">Copy Token</button>
              </div>
            </div>
          {/if}

          <!-- Token list -->
          <div class="space-y-3">
            <div class="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
              Token Assignments
              <InfoTooltip text="Each token carries profiles. Resolved namespaces show effective access after profile and namespace matching." />
            </div>

            <div class="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
              <table class="w-full text-sm">
                <thead class="bg-slate-50 dark:bg-slate-950/40">
                  <tr>
                    <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">User ID</th>
                    <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Profiles</th>
                    <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Resolved namespaces</th>
                    <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Blocked actions</th>
                    <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Token</th>
                    <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Actions</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                  {#if loading}
                    <tr><td colspan="6" class="px-4 py-8 text-center text-slate-500 dark:text-slate-400">Loading…</td></tr>
                  {:else if authTokens.length === 0}
                    <tr><td colspan="6" class="px-4 py-8 text-center text-slate-500 dark:text-slate-400">No client tokens configured.</td></tr>
                  {:else}
                    {#each authTokens as tokenRow}
                      {@const resolved = resolveTokenAccess(tokenRow)}
                      {@const warnings = tokenWarnings.get(tokenRow.token) ?? []}
                      <tr class="align-top">
                        <td class="px-4 py-3 text-slate-900 dark:text-white font-medium">{tokenRow.userId}</td>
                        <td class="px-4 py-3">
                          <div class="flex gap-1 flex-wrap">
                            {#each tokenRow.roles as role}
                              {@const exists = profileNames.has(role)}
                              <Badge variant={exists ? 'info' : 'danger'}>{role}{exists ? '' : ' ✗'}</Badge>
                            {/each}
                          </div>
                        </td>
                        <td class="px-4 py-3">
                          <div class="flex gap-1 flex-wrap">
                            {#each resolved.resolvedNamespaces as ns}
                              <Badge variant="success">{ns}</Badge>
                            {/each}
                            {#if resolved.resolvedNamespaces.length === 0}
                              <span class="text-xs text-slate-400">—</span>
                            {/if}
                          </div>
                        </td>
                        <td class="px-4 py-3 text-slate-700 dark:text-slate-300">
                          {#if resolved.blockedActions.length > 0}
                            <div class="flex gap-1 flex-wrap">
                              {#each resolved.blockedActions as action}
                                <Badge variant="muted">{action}</Badge>
                              {/each}
                            </div>
                          {:else}
                            <span class="text-xs text-slate-400">—</span>
                          {/if}
                        </td>
                        <td class="px-4 py-3">
                          <code class="block break-all text-xs text-slate-600 dark:text-slate-300 max-w-[200px] truncate" title={tokenRow.token}>{tokenRow.token}</code>
                        </td>
                        <td class="px-4 py-3">
                          <div class="flex flex-wrap gap-1.5">
                            <button onclick={() => copyText(tokenRow.token, 'Token')} class="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">Copy</button>
                            <button onclick={() => copyText(`Authorization: Bearer ${tokenRow.token}`, 'Header')} class="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">Header</button>
                            <button onclick={() => openEditToken(tokenRow)} class="px-2.5 py-1.5 text-xs rounded-lg border border-indigo-300 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors">Edit</button>
                            <button onclick={() => requestRevokeToken(tokenRow.token, tokenRow.userId)} disabled={tokenSaving} class="px-2.5 py-1.5 text-xs rounded-lg border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors disabled:opacity-50">Revoke</button>
                          </div>
                        </td>
                      </tr>
                      {#if warnings.length > 0}
                        <tr>
                          <td colspan="6" class="px-4 py-2 bg-amber-50/50 dark:bg-amber-950/20">
                            <div class="flex gap-3 flex-wrap">
                              {#each warnings as w}
                                <Badge variant="warning">{w}</Badge>
                              {/each}
                            </div>
                          </td>
                        </tr>
                      {/if}
                    {/each}
                  {/if}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- ═══════════════════════ MODALS ═══════════════════════ -->

<!-- Assign Server modal -->
<Modal
  open={assignServerTarget !== null}
  title="Assign Server to {assignServerTarget?.namespaceKey ?? ''}"
  onclose={() => (assignServerTarget = null)}
  widthClass="max-w-lg"
>
  {#snippet children()}
    <div class="space-y-3">
      {#if serversForAssign.length === 0}
        <p class="text-sm text-slate-500 dark:text-slate-400">All configured servers are already in this namespace.</p>
      {:else}
        <p class="text-sm text-slate-500 dark:text-slate-400">Select servers to add to this namespace.</p>
        <div class="space-y-1 max-h-64 overflow-y-auto">
          {#each serversForAssign as server}
            <label
              class="flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 {assignServerIds.includes(server.id) ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30' : 'border-slate-200 dark:border-slate-700'}"
            >
              <input type="checkbox" value={server.id} bind:group={assignServerIds} class="accent-indigo-600" />
              <div>
                <span class="text-sm font-medium text-slate-900 dark:text-white">{server.id}</span>
                <span class="ml-2 text-xs text-slate-400">currently in {server.namespaces.join(', ')}</span>
              </div>
            </label>
          {/each}
        </div>
      {/if}
    </div>
  {/snippet}
  {#snippet footer()}
    <button
      onclick={() => (assignServerTarget = null)}
      class="px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
    >
      Cancel
    </button>
    <button
      onclick={assignServerToNamespace}
      disabled={assignServerIds.length === 0}
      class="px-3 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 transition-colors"
    >
      Assign{assignServerIds.length > 0 ? ` (${assignServerIds.length})` : ''}
    </button>
  {/snippet}
</Modal>

<!-- Confirmation modal -->
<Modal open={confirmAction !== null} title={confirmAction?.title ?? ''} onclose={() => (confirmAction = null)}>
  <p class="text-sm text-slate-700 dark:text-slate-300">{confirmAction?.message ?? ''}</p>
  {#snippet footer()}
    <button
      onclick={() => (confirmAction = null)}
      class="px-4 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
    >
      Cancel
    </button>
    <button
      onclick={() => confirmAction?.onConfirm()}
      class="px-4 py-2 text-sm font-medium rounded-lg text-white {confirmAction?.variant === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'} transition-colors"
    >
      Confirm
    </button>
  {/snippet}
</Modal>

<!-- Edit token modal -->
<Modal open={editingToken !== null} title="Edit Token" onclose={() => (editingToken = null)}>
  {#if editingToken}
    <div class="space-y-4">
      <label class="block space-y-1">
        <span class="text-xs font-medium text-slate-500 dark:text-slate-400">User ID</span>
        <input bind:value={editingToken.userId} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
      </label>

      <div class="space-y-2">
        <span class="text-xs font-medium text-slate-500 dark:text-slate-400">Permission profiles</span>
        <div class="flex gap-3 flex-wrap">
          {#each roles as role}
            {@const name = role.key.trim()}
            {#if name}
              <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={editingToken.roles.includes(name)}
                  onchange={() => toggleEditTokenRole(name)}
                  class="rounded border-slate-300 dark:border-slate-600"
                />
                {name}
              </label>
            {/if}
          {/each}
        </div>
      </div>
    </div>
  {/if}
  {#snippet footer()}
    <button
      onclick={() => (editingToken = null)}
      class="px-4 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
    >
      Cancel
    </button>
    <button
      onclick={saveEditingToken}
      disabled={tokenSaving}
      class="px-4 py-2 text-sm font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
    >
      {tokenSaving ? 'Saving…' : 'Save'}
    </button>
  {/snippet}
</Modal>
