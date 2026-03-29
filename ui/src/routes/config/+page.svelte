<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getPolicies,
    savePolicies,
    getConfig,
    getConfigVersions,
    rollbackConfig,
    exportConfig,
    type PoliciesConfig,
    type PoliciesAuthConfig,
    type InboundOAuthPolicy,
  } from '$lib/api.js';
  import { notifications } from '$lib/stores/notifications.js';
  import Badge from '../../components/ui/Badge.svelte';
  import Modal from '../../components/ui/Modal.svelte';
  import InfoTooltip from '../../components/ui/InfoTooltip.svelte';

  let policies = $state<PoliciesConfig | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let configSource = $state<'db' | 'file'>('file');
  let versions = $state<{ id: number; createdAt: string; source: string; createdBy: string; comment?: string }[]>([]);
  let rollbackTarget = $state<number | null>(null);
  let rolling = $state(false);
  let starterPackJson = $state('{}');
  let allowedOAuthProvidersText = $state('');
  let oauthIssuersJson = $state('[{ "issuer": "https://issuer.example" }]');
  let primaryOAuthIssuer = $state('');
  let detectedPublicBaseUrl = $state('http://127.0.0.1:3000');
  let oauthAdvancedOpen = $state(false);
  let authExperienceMode = $state<'default' | 'advanced'>('default');
  let oauthRequireNsText = $state('');
  let oauthScopesText = $state('');
  let oauthOriginsText = $state('');

  const defaultWebClientOrigins = ['https://chatgpt.com', 'https://claude.ai'];

  function parseAllowedOAuthProviders(text: string): string[] {
    return [...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    )];
  }

  function mergeDefaultBrowserOrigins(origins: string[] | undefined): string[] {
    return [...new Set([...defaultWebClientOrigins, ...(origins ?? [])])];
  }

  function currentOAuthProvider(auth: PoliciesAuthConfig): 'embedded' | 'external' {
    if (auth.mode !== 'oauth' && auth.mode !== 'hybrid') return 'embedded';
    if (auth.oauth.provider === 'embedded' || auth.oauth.provider === 'external') return auth.oauth.provider;
    return auth.oauth.authorizationServers.length > 0 ? 'external' : 'embedded';
  }

  function detectAuthExperienceMode(auth: PoliciesAuthConfig): 'default' | 'advanced' {
    if (auth.mode === 'hybrid' && currentOAuthProvider(auth) === 'embedded') {
      return 'default';
    }
    return 'advanced';
  }

  function detectPublicBaseUrl(): string {
    if (typeof window === 'undefined') return 'http://127.0.0.1:3000';
    return window.location.origin.replace(/\/$/, '');
  }

  function hasAdvancedOAuthSettings(oauth: InboundOAuthPolicy): boolean {
    if (oauth.authorizationServers.length > 1) return true;
    const primary = oauth.authorizationServers[0];
    if (primary?.audience || primary?.jwksUri) return true;
    if (primary?.rolesClaim && primary.rolesClaim !== 'roles') return true;
    return Boolean(
      (oauth.requireForNamespaces && oauth.requireForNamespaces.length > 0) ||
        (oauth.scopesSupported && oauth.scopesSupported.length > 0) ||
        (oauth.allowedBrowserOrigins && oauth.allowedBrowserOrigins.length > 0),
    );
  }

  function defaultInboundOAuth(baseUrl = detectedPublicBaseUrl): InboundOAuthPolicy {
    return {
      provider: 'embedded',
      publicBaseUrl: baseUrl,
      authorizationServers: [],
      allowedBrowserOrigins: [...defaultWebClientOrigins],
    };
  }

  function hydrateOAuthFields(oauth: InboundOAuthPolicy) {
    oauthIssuersJson = JSON.stringify(oauth.authorizationServers, null, 2);
    primaryOAuthIssuer = oauth.authorizationServers[0]?.issuer ?? '';
    detectedPublicBaseUrl = detectPublicBaseUrl();
    oauthAdvancedOpen = hasAdvancedOAuthSettings(oauth);
    oauthRequireNsText = (oauth.requireForNamespaces ?? []).join('\n');
    oauthScopesText = (oauth.scopesSupported ?? []).join('\n');
    oauthOriginsText = (oauth.allowedBrowserOrigins ?? []).filter((origin) => !defaultWebClientOrigins.includes(origin)).join('\n');
  }

  function setExperienceMode(mode: 'default' | 'advanced') {
    authExperienceMode = mode;
    if (!policies) return;
    if (mode === 'default') {
      const cur = policies.auth;
      const oauth = cur.mode === 'oauth' || cur.mode === 'hybrid' ? cur.oauth : defaultInboundOAuth();
      policies.auth = {
        mode: 'hybrid',
        staticKeys: cur.mode === 'static_key' || cur.mode === 'hybrid' ? cur.staticKeys : undefined,
        oauth: {
          ...oauth,
          provider: 'embedded',
          authorizationServers: [],
          publicBaseUrl: oauth.publicBaseUrl || detectedPublicBaseUrl,
          allowedBrowserOrigins: mergeDefaultBrowserOrigins(oauth.allowedBrowserOrigins),
        },
      };
      hydrateOAuthFields(policies.auth.oauth);
    }
  }

  function setOAuthProvider(provider: 'embedded' | 'external') {
    if (!policies) return;
    if (policies.auth.mode !== 'oauth' && policies.auth.mode !== 'hybrid') return;
    policies.auth.oauth = {
      ...policies.auth.oauth,
      provider,
      authorizationServers:
        provider === 'embedded'
          ? []
          : policies.auth.oauth.authorizationServers.length > 0
            ? policies.auth.oauth.authorizationServers
            : [{ issuer: primaryOAuthIssuer.trim() || '', rolesClaim: 'roles' }],
    };
    if (provider === 'embedded') {
      primaryOAuthIssuer = '';
    }
  }

  function toggleOAuthAdvanced() {
    if (!oauthAdvancedOpen && policies && (policies.auth.mode === 'oauth' || policies.auth.mode === 'hybrid')) {
      const currentPrimary = policies.auth.oauth.authorizationServers[0] ?? { rolesClaim: 'roles' };
      oauthIssuersJson = JSON.stringify([{ ...currentPrimary, issuer: primaryOAuthIssuer.trim() }], null, 2);
    }
    oauthAdvancedOpen = !oauthAdvancedOpen;
  }

  function setClientAuthMode(mode: PoliciesAuthConfig['mode']) {
    if (!policies) return;
    const cur = policies.auth;
    if (mode === 'static_key') {
      policies.auth = {
        mode: 'static_key',
        staticKeys: cur.mode === 'static_key' || cur.mode === 'hybrid' ? cur.staticKeys : undefined,
      };
      return;
    }
    if (mode === 'oauth') {
      const oauth = cur.mode === 'oauth' || cur.mode === 'hybrid' ? cur.oauth : defaultInboundOAuth();
      policies.auth = { mode: 'oauth', oauth };
      hydrateOAuthFields(oauth);
      return;
    }
    const oauth = cur.mode === 'oauth' || cur.mode === 'hybrid' ? cur.oauth : defaultInboundOAuth();
    policies.auth = {
      mode: 'hybrid',
      staticKeys: cur.mode === 'static_key' || cur.mode === 'hybrid' ? cur.staticKeys : undefined,
      oauth,
    };
    hydrateOAuthFields(oauth);
  }

  async function load() {
    loading = true;
    try {
      detectedPublicBaseUrl = detectPublicBaseUrl();
      const [policyRes, configRes] = await Promise.all([getPolicies(), getConfig()]);
      policies = {
        ...policyRes,
        codeMode: policyRes.codeMode ?? {
          memoryLimitMb: 128,
          executionTimeoutMs: 10_000,
          maxToolCallsPerExecution: 20,
          maxResultSizeBytes: 1_048_576,
          artifactStoreTtlSeconds: 300,
        },
      };
      configSource = configRes.source === 'db' ? 'db' : 'file';
      versions = configSource === 'db' ? (await getConfigVersions()).versions : [];
      starterPackJson = JSON.stringify(policyRes.starterPacks, null, 2);
      allowedOAuthProvidersText = (policyRes.allowedOAuthProviders ?? []).join('\n');
      if (policyRes.auth.mode === 'oauth' || policyRes.auth.mode === 'hybrid') {
        if (!policyRes.auth.oauth.publicBaseUrl) {
          policyRes.auth.oauth.publicBaseUrl = detectedPublicBaseUrl;
        }
        hydrateOAuthFields(policyRes.auth.oauth);
      }
      authExperienceMode = detectAuthExperienceMode(policyRes.auth);
    } catch {
      notifications.error('Failed to load configuration');
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (!policies) return;
    saving = true;
    try {
      let auth: PoliciesConfig['auth'] = policies.auth;
      if (authExperienceMode === 'default') {
        const cur = policies.auth;
        const oauth = cur.mode === 'oauth' || cur.mode === 'hybrid' ? cur.oauth : defaultInboundOAuth();
        auth = {
          mode: 'hybrid',
          staticKeys: cur.mode === 'static_key' || cur.mode === 'hybrid' ? cur.staticKeys : undefined,
          oauth: {
            ...oauth,
            provider: 'embedded',
            publicBaseUrl: oauth.publicBaseUrl?.trim() || detectedPublicBaseUrl,
            authorizationServers: [],
            allowedBrowserOrigins: mergeDefaultBrowserOrigins(parseAllowedOAuthProviders(oauthOriginsText)),
          },
        };
      } else if (policies.auth.mode === 'oauth' || policies.auth.mode === 'hybrid') {
        let authorizationServers: InboundOAuthPolicy['authorizationServers'];
        const provider = currentOAuthProvider(policies.auth);
        if (oauthAdvancedOpen) {
          try {
            const parsed = JSON.parse(oauthIssuersJson);
            if (!Array.isArray(parsed)) {
              throw new Error('Authorization servers must be a JSON array');
            }
            authorizationServers = provider === 'embedded' ? [] : parsed;
          } catch (e) {
            notifications.error(e instanceof Error ? e.message : 'Invalid authorization servers JSON');
            saving = false;
            return;
          }
          if (provider === 'external' && policies.auth.mode === 'oauth' && authorizationServers.length === 0) {
            notifications.error('Issuer URL is required to enable OAuth web clients');
            saving = false;
            return;
          }
        } else {
          const issuer = primaryOAuthIssuer.trim();
          if (provider === 'external' && policies.auth.mode === 'oauth' && !issuer) {
            notifications.error('Issuer URL is required to enable OAuth web clients');
            saving = false;
            return;
          }
          const currentPrimary = policies.auth.oauth.authorizationServers[0] ?? { rolesClaim: 'roles' };
          authorizationServers = provider === 'embedded' ? [] : issuer ? [{ ...currentPrimary, issuer }] : [];
        }
        auth = {
          ...policies.auth,
          oauth: {
            ...policies.auth.oauth,
            provider,
            publicBaseUrl: policies.auth.oauth.publicBaseUrl?.trim() || detectedPublicBaseUrl,
            authorizationServers,
            requireForNamespaces:
              parseAllowedOAuthProviders(oauthRequireNsText).length > 0
                ? parseAllowedOAuthProviders(oauthRequireNsText)
                : undefined,
            scopesSupported:
              parseAllowedOAuthProviders(oauthScopesText).length > 0
                ? parseAllowedOAuthProviders(oauthScopesText)
                : undefined,
            allowedBrowserOrigins:
              mergeDefaultBrowserOrigins(parseAllowedOAuthProviders(oauthOriginsText)),
          },
        };
      }
      await savePolicies(
        {
          ...policies,
          auth,
          starterPacks: JSON.parse(starterPackJson),
          allowedOAuthProviders: parseAllowedOAuthProviders(allowedOAuthProvidersText),
        },
        'Updated tuning',
      );
      notifications.success('Gateway tuning updated');
      await load();
    } catch (err) {
      notifications.error(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      saving = false;
    }
  }

  async function handleRollback() {
    if (rollbackTarget === null || configSource !== 'db') return;
    rolling = true;
    try {
      await rollbackConfig(rollbackTarget);
      notifications.success(`Rolled back to version ${rollbackTarget}`);
      rollbackTarget = null;
      await load();
    } catch {
      notifications.error('Failed to rollback');
    } finally {
      rolling = false;
    }
  }

  async function handleExport() {
    try {
      const json = await exportConfig();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'gateway-admin-config.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      notifications.error('Failed to export config');
    }
  }

  onMount(() => {
    detectedPublicBaseUrl = detectPublicBaseUrl();
    void load();
  });

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString();
  }
</script>

<svelte:head>
  <title>Configuration — MCPR Gateway</title>
</svelte:head>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold text-slate-900 dark:text-white inline-flex items-center gap-2">
        Configuration
        <InfoTooltip text="Runtime tuning: inbound MCP auth (Bearer / OAuth), selector, publication compression, session triggers, resilience, code-mode sandbox limits, debug, and starter packs. Matches keys under bootstrap.json / DB-backed admin config." />
      </h1>
    </div>
    <div class="flex gap-2">
      <button onclick={handleExport} class="px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700">Export JSON</button>
      <button onclick={save} disabled={saving || loading} class="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50">
        {saving ? 'Saving…' : 'Save Config'}
      </button>
    </div>
  </div>

  {#if loading || !policies}
    <div class="p-6 text-sm text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800">Loading…</div>
  {:else}
    <div class="grid grid-cols-1 xl:grid-cols-3 gap-5">
      <div class="xl:col-span-2 space-y-5">
        {#if configSource === 'file'}
          <div class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            Saving to <code class="font-mono">bootstrap.json</code> · Version history requires SQLite persistence.
          </div>
        {/if}

        <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5 space-y-4">
          <h2 class="text-sm font-semibold text-slate-900 dark:text-white inline-flex items-center gap-2">
            Client access
            <InfoTooltip text="Choose how MCP clients authenticate to this gateway. The recommended mode keeps existing Bearer tokens working and also enables OAuth discovery for web clients like ChatGPT." />
          </h2>
          <label class="block text-sm space-y-1 max-w-md">
            <span class="text-slate-600 dark:text-slate-300">Setup mode</span>
            <select
              class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
              value={authExperienceMode}
              onchange={(e) => setExperienceMode(e.currentTarget.value as 'default' | 'advanced')}
            >
              <option value="default">Default</option>
              <option value="advanced">Advanced</option>
            </select>
          </label>

          {#if authExperienceMode === 'default' && (policies.auth.mode === 'oauth' || policies.auth.mode === 'hybrid')}
            <div class="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-100">
              Default mode keeps Bearer-token clients working and enables built-in OAuth discovery for ChatGPT and Claude Web automatically.
            </div>
            <label class="block text-sm space-y-1 max-w-xl">
              <span class="flex items-center gap-1 text-slate-600 dark:text-slate-300">
                Public base URL
                <InfoTooltip text="Public origin clients use to reach the gateway. The UI auto-detects this from the current admin URL." />
              </span>
              <input
                type="url"
                bind:value={policies.auth.oauth.publicBaseUrl}
                placeholder={detectedPublicBaseUrl}
                class="w-full max-w-xl px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono text-[13px]"
              />
            </label>
            <label class="block text-sm space-y-1">
              <span class="flex items-center gap-1 text-slate-600 dark:text-slate-300">
                Additional browser origins
                <InfoTooltip text="ChatGPT and Claude are already enabled by default. Add extra browser origins here only if you need other MCP web clients." />
              </span>
              <textarea
                bind:value={oauthOriginsText}
                rows="2"
                placeholder="https://your-other-client.example"
                class="w-full max-w-xl px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono text-[12px]"
              ></textarea>
            </label>
          {:else if policies.auth.mode === 'oauth' || policies.auth.mode === 'hybrid'}
            <label class="block text-sm space-y-1 max-w-md">
              <span class="text-slate-600 dark:text-slate-300">Compatibility mode</span>
              <select
                class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                value={policies.auth.mode}
                onchange={(e) => setClientAuthMode(e.currentTarget.value as PoliciesAuthConfig['mode'])}
              >
                <option value="static_key">Bearer tokens only</option>
                <option value="hybrid">Bearer tokens + OAuth web clients</option>
                <option value="oauth">OAuth only</option>
              </select>
            </label>
            <label class="block text-sm space-y-1 max-w-md">
              <span class="text-slate-600 dark:text-slate-300">OAuth provider</span>
              <select
                class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                value={currentOAuthProvider(policies.auth)}
                onchange={(e) => setOAuthProvider(e.currentTarget.value as 'embedded' | 'external')}
              >
                <option value="embedded">Built-in OAuth</option>
                <option value="external">External IdP</option>
              </select>
            </label>
            <button
              type="button"
              class="text-sm font-medium text-slate-700 underline underline-offset-2 dark:text-slate-300"
              onclick={toggleOAuthAdvanced}
            >
              {oauthAdvancedOpen ? 'Hide advanced OAuth settings' : 'Show advanced OAuth settings'}
            </button>
            {#if currentOAuthProvider(policies.auth) === 'external'}
              <label class="block text-sm space-y-1 max-w-xl">
                <span class="flex items-center gap-1 text-slate-600 dark:text-slate-300">
                  OAuth issuer
                  <InfoTooltip text="Issuer URL from the identity provider that signs the inbound JWTs. Required only when using an external IdP." />
                </span>
                <input
                  type="url"
                  bind:value={primaryOAuthIssuer}
                  placeholder="https://issuer.example.com"
                  class="w-full max-w-xl px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono text-[13px]"
                />
              </label>
            {/if}
            {#if oauthAdvancedOpen}
              <div class="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-4">
                <p class="text-xs text-slate-500 dark:text-slate-400">
                  Advanced settings are optional. Leave them empty to apply defaults across all namespaces.
                </p>
                <label class="block text-sm space-y-1">
                  <span class="flex items-center gap-1 text-slate-600 dark:text-slate-300">
                    Authorization servers (JSON array)
                    <InfoTooltip text="Each JSON object: issuer (required), plus optional audience, jwksUri, rolesClaim. If jwksUri is omitted, the gateway discovers the JWKS URL via OpenID or OAuth authorization-server metadata." />
                  </span>
                  <textarea
                    bind:value={oauthIssuersJson}
                    rows="6"
                    class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono text-[12px]"
                  ></textarea>
                </label>
                <label class="block text-sm space-y-1">
                  <span class="flex items-center gap-1 text-slate-600 dark:text-slate-300">
                    Require OAuth only for namespaces (one per line)
                    <InfoTooltip text="If empty, every configured namespace uses OAuth when mode is OAuth or hybrid. If set, only listed namespaces require JWT." />
                  </span>
                  <textarea
                    bind:value={oauthRequireNsText}
                    rows="3"
                    placeholder="e.g. gmail"
                    class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono text-[12px]"
                  ></textarea>
                </label>
                <label class="block text-sm space-y-1">
                  <span class="flex items-center gap-1 text-slate-600 dark:text-slate-300">
                    Scopes supported (one per line)
                    <InfoTooltip text="Advertised in protected-resource metadata and WWW-Authenticate. If empty, the gateway advertises openid." />
                  </span>
                  <textarea
                    bind:value={oauthScopesText}
                    rows="2"
                    class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono text-[12px]"
                  ></textarea>
                </label>
                <label class="block text-sm space-y-1">
                  <span class="flex items-center gap-1 text-slate-600 dark:text-slate-300">
                    Allowed browser origins (one per line)
                    <InfoTooltip text="ChatGPT and Claude web are included automatically. Add extra browser origins here if you need them. Non-browser clients without Origin header are still allowed." />
                  </span>
                  <textarea
                    bind:value={oauthOriginsText}
                    rows="2"
                    placeholder="https://chatgpt.com&#10;https://claude.ai"
                    class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono text-[12px]"
                  ></textarea>
                </label>
              </div>
            {/if}
          {:else}
            <p class="text-xs text-slate-500 dark:text-slate-400">
              Client Bearer tokens are managed under <strong>Access Control</strong>. Namespace policies (roles) still apply after the token is resolved.
            </p>
          {/if}
        </div>

        <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5 space-y-4">
          <h2 class="text-sm font-semibold text-slate-900 dark:text-white inline-flex items-center gap-2">
            Selector
            <InfoTooltip text="Tune how the selector ranks candidates when it runs (e.g. session refresh in compat mode). Does not change gateway_search_tools, which always uses BM25." />
          </h2>
          <div class="flex flex-wrap gap-6 text-sm text-slate-600 dark:text-slate-300">
            <label class="flex items-center gap-2">
              <input type="checkbox" bind:checked={policies.selector.lexical.enabled} />
              <span class="inline-flex items-center gap-1">
                BM25 / lexical ranking
                <InfoTooltip text="When enabled, adds a BM25/RRF stage to the selector’s hybrid ranker (intent text + tool fields). Off: context/heuristic signals only. gateway_search_tools always ranks with BM25 regardless of this switch." />
              </span>
            </label>
          </div>
          <h3 class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 pt-1">Focus</h3>
          <div class="flex flex-wrap gap-4 text-sm text-slate-600 dark:text-slate-300">
            <label class="flex items-center gap-2">
              <input type="checkbox" bind:checked={policies.selector.focus.enabled} />
              <span class="inline-flex items-center gap-1">
                Enabled
                <InfoTooltip text="Capability-focused selection using recent successful tool usage. Only active in compat/code modes. Basically keeps tools more aligned to recent use. Can make things more difficult in complex scenarios such as different upstream mcp servers usage on same request." />
              </span>
            </label>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Lookback <InfoTooltip text="Recent tool calls considered for focus scoring." />
              </span>
              <input type="number" autocomplete="off" min="1" bind:value={policies.selector.focus.lookback} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Min dominant successes <InfoTooltip text="Minimum successes on a capability before it is treated as dominant." />
              </span>
              <input type="number" autocomplete="off" min="1" bind:value={policies.selector.focus.minDominantSuccesses} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Reserve slots <InfoTooltip text="Slots reserved when building the tool window under focus mode." />
              </span>
              <input type="number" autocomplete="off" min="0" bind:value={policies.selector.focus.reserveSlots} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Cross-domain penalty <InfoTooltip text="Penalty when mixing unrelated capabilities in the same window." />
              </span>
              <input type="number" autocomplete="off" step="0.1" bind:value={policies.selector.focus.crossDomainPenalty} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
          </div>
          <h3 class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 pt-1">Publication compression</h3>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Description compression <InfoTooltip text="When conservative, shortens downstream tool descriptions in tools/list (gateway’s own tools are never compressed). Default off — full text." />
              </span>
              <select autocomplete="off" bind:value={policies.selector.publication.descriptionCompression} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800">
                <option value="off">off</option>
                <option value="conservative">conservative</option>
              </select>
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Schema compression <InfoTooltip text="When conservative, simplifies JSON Schemas for downstream tools in tools/list. Default off — full schema." />
              </span>
              <select autocomplete="off" bind:value={policies.selector.publication.schemaCompression} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800">
                <option value="off">off</option>
                <option value="conservative">conservative</option>
              </select>
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Description max length <InfoTooltip text="Maximum characters after conservative cleanup (first sentence, etc.). Use 0 for no length cap. Only applies when Description compression is conservative; the off setting is the dropdown above, not this number." />
              </span>
              <input type="number" autocomplete="off" min="0" bind:value={policies.selector.publication.descriptionMaxLength} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
          </div>
          <div class="grid grid-cols-3 gap-3">
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Write penalty <InfoTooltip text="In the selector ranker only: when the session mode is Read, multiplies a score penalty for tools marked High risk (magnitude = value × 5). 0 disables this bias." />
              </span>
              <input type="number" autocomplete="off" step="0.05" bind:value={policies.selector.penalties.write} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Admin penalty <InfoTooltip text="In the selector ranker only: when the session mode is Admin, score penalty for High-risk tools (magnitude = value × 5). 0 disables." />
              </span>
              <input type="number" autocomplete="off" step="0.05" bind:value={policies.selector.penalties.admin} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Unhealthy penalty <InfoTooltip text="Scales fixed health-based score adjustments in the selector (degraded/offline/unknown). 0.5 matches historical strength; 0 removes that scaling (no extra penalty from this setting)." />
              </span>
              <input type="number" autocomplete="off" step="0.05" bind:value={policies.selector.penalties.unhealthyDownstream} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
          </div>
        </div>

        <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5 space-y-4">
          <h2 class="text-sm font-semibold text-slate-900 dark:text-white">Session & Triggers</h2>
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                TTL (s) <InfoTooltip text="Session expiry in seconds. After this time with no activity, the session is cleaned up." />
              </span>
              <input type="number" autocomplete="off" bind:value={policies.session.ttlSeconds} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Cleanup interval (s) <InfoTooltip text="How often the cleanup sweep runs to remove expired sessions." />
              </span>
              <input type="number" autocomplete="off" bind:value={policies.session.cleanupIntervalSeconds} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Cooldown (s) <InfoTooltip text="Minimum time between window reselections triggered by tool outcomes." />
              </span>
              <input type="number" autocomplete="off" bind:value={policies.triggers.cooldownSeconds} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Window mode <InfoTooltip text="replace: new window replaces the old one. append: new tools are merged into the existing window." />
              </span>
              <select autocomplete="off" bind:value={policies.triggers.replaceOrAppend} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800">
                <option value="replace">replace</option>
                <option value="append">append</option>
              </select>
            </label>
          </div>
          <div class="flex gap-6 text-sm text-slate-600 dark:text-slate-300">
            <span class="font-medium text-slate-500 dark:text-slate-400">Triggers:</span>
            <label class="flex items-center gap-2"><input type="checkbox" bind:checked={policies.triggers.refreshOnSuccess} /> Refresh on success</label>
            <label class="flex items-center gap-2"><input type="checkbox" bind:checked={policies.triggers.refreshOnTimeout} /> Refresh on timeout</label>
            <label class="flex items-center gap-2"><input type="checkbox" bind:checked={policies.triggers.refreshOnError} /> Refresh on error</label>
          </div>
        </div>

        <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5 space-y-4">
          <h2 class="text-sm font-semibold text-slate-900 dark:text-white">Resilience</h2>
          <div class="grid grid-cols-3 gap-3">
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Connect timeout (ms) <InfoTooltip text="Max time to establish a TCP connection to a downstream server." />
              </span>
              <input type="number" autocomplete="off" bind:value={policies.resilience.timeouts.connectMs} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Response timeout (ms) <InfoTooltip text="Max time to wait for the first byte of a response." />
              </span>
              <input type="number" autocomplete="off" bind:value={policies.resilience.timeouts.responseMs} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Total timeout (ms) <InfoTooltip text="Hard limit for the entire request lifecycle." />
              </span>
              <input type="number" autocomplete="off" bind:value={policies.resilience.timeouts.totalMs} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Rate limit / session <InfoTooltip text="Max requests per MCP session within the session window." />
              </span>
              <input type="number" autocomplete="off" bind:value={policies.resilience.rateLimit.perSession.maxRequests} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Session rate window (s) <InfoTooltip text="Sliding window length for per-session rate limiting." />
              </span>
              <input type="number" autocomplete="off" min="1" bind:value={policies.resilience.rateLimit.perSession.windowSeconds} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Rate limit / user <InfoTooltip text="Max requests per user across all sessions within the user window." />
              </span>
              <input type="number" autocomplete="off" bind:value={policies.resilience.rateLimit.perUser.maxRequests} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                User rate window (s) <InfoTooltip text="Sliding window length for per-user rate limiting." />
              </span>
              <input type="number" autocomplete="off" min="1" bind:value={policies.resilience.rateLimit.perUser.windowSeconds} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Downstream concurrency <InfoTooltip text="Max simultaneous requests forwarded to a single downstream server." />
              </span>
              <input type="number" autocomplete="off" bind:value={policies.resilience.rateLimit.perDownstreamConcurrency} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Degraded after (failures) <InfoTooltip text="Mark server degraded after this many consecutive failures." />
              </span>
              <input type="number" autocomplete="off" bind:value={policies.resilience.circuitBreaker.degradedAfterFailures} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Offline after (failures) <InfoTooltip text="Mark server offline (circuit open) after this many consecutive failures." />
              </span>
              <input type="number" autocomplete="off" bind:value={policies.resilience.circuitBreaker.offlineAfterFailures} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Reset after (s) <InfoTooltip text="Time in seconds before attempting to reconnect an offline server." />
              </span>
              <input type="number" autocomplete="off" bind:value={policies.resilience.circuitBreaker.resetAfterSeconds} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
          </div>
        </div>

        <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5 space-y-4">
          <h2 class="text-sm font-semibold text-slate-900 dark:text-white inline-flex items-center gap-2">
            Code mode
            <InfoTooltip text="Sandbox limits for gateway_run_code: memory, execution time, tool calls per run, result size, and artifact TTL." />
          </h2>
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Memory limit (MB) <InfoTooltip text="Max heap for the isolated JS runtime." />
              </span>
              <input type="number" autocomplete="off" min="1" bind:value={policies.codeMode.memoryLimitMb} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Execution timeout (ms) <InfoTooltip text="Hard limit for a single gateway_run_code execution." />
              </span>
              <input type="number" autocomplete="off" min="1" bind:value={policies.codeMode.executionTimeoutMs} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Max tool calls / execution <InfoTooltip text="Cap on downstream tool calls from one code execution." />
              </span>
              <input type="number" autocomplete="off" min="1" bind:value={policies.codeMode.maxToolCallsPerExecution} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Max result size (bytes) <InfoTooltip text="Maximum serialized result size returned from the sandbox." />
              </span>
              <input type="number" autocomplete="off" min="1" bind:value={policies.codeMode.maxResultSizeBytes} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
            <label class="space-y-1">
              <span class="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Artifact store TTL (s) <InfoTooltip text="How long saved artifacts remain available after a run." />
              </span>
              <input type="number" autocomplete="off" min="1" bind:value={policies.codeMode.artifactStoreTtlSeconds} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800" />
            </label>
          </div>
        </div>

        <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5 space-y-3">
          <label class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" bind:checked={policies.debug.enabled} />
            <span class="inline-flex items-center gap-1">
              Debug routes enabled
              <InfoTooltip text="Exposes additional diagnostic HTTP routes; disable in production unless troubleshooting." />
            </span>
          </label>
        </div>

        <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5 space-y-3">
          <h2 class="text-sm font-semibold text-slate-900 dark:text-white">Starter Packs</h2>
          <textarea autocomplete="off" bind:value={starterPackJson} rows="12" class="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"></textarea>
        </div>

        <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5 space-y-3">
          <h2 class="text-sm font-semibold text-slate-900 dark:text-white inline-flex items-center gap-2">
            OAuth provider allowlist
            <InfoTooltip text="If empty, OAuth authorization still requires HTTPS and SSRF-safe endpoints. If populated, only matching origins or wildcard patterns are accepted when starting downstream OAuth." />
          </h2>
          <p class="text-xs text-slate-500 dark:text-slate-400">
            One entry per line. Examples: <code class="font-mono">https://issuer.example.com</code> or <code class="font-mono">*.example.com</code>.
          </p>
          <textarea
            bind:value={allowedOAuthProvidersText}
            rows="5"
            autocomplete="off"
            placeholder="https://issuer.example.com&#10;*.example.com"
            class="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
          ></textarea>
        </div>
      </div>

      <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800">
        <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <p class="text-sm font-medium text-slate-700 dark:text-slate-300">Version History</p>
        </div>
        <div class="divide-y divide-slate-100 dark:divide-slate-800 max-h-[40rem] overflow-y-auto">
          {#if configSource === 'file'}
            <p class="px-4 py-6 text-sm text-slate-500 dark:text-slate-400 text-center">No version history in file mode</p>
          {:else if versions.length === 0}
            <p class="px-4 py-6 text-sm text-slate-500 dark:text-slate-400 text-center">No saved versions</p>
          {:else}
            {#each versions as v}
              <div class="px-4 py-3 flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-medium text-slate-700 dark:text-slate-300">v{v.id}</span>
                    <Badge variant="muted">{v.source}</Badge>
                  </div>
                  <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{formatDate(v.createdAt)}</p>
                  {#if v.comment}
                    <p class="text-xs text-slate-500 dark:text-slate-500 mt-0.5 italic">{v.comment}</p>
                  {/if}
                </div>
                <button onclick={() => (rollbackTarget = v.id)} class="text-xs text-indigo-600 dark:text-indigo-400">Rollback</button>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<Modal open={rollbackTarget !== null} title="Rollback Configuration" onclose={() => (rollbackTarget = null)}>
  {#snippet children()}
    <p class="text-sm text-slate-600 dark:text-slate-400">
      Roll back to configuration version <strong>v{rollbackTarget}</strong>? The current runtime config will be replaced immediately.
    </p>
  {/snippet}
  {#snippet footer()}
    <button onclick={() => (rollbackTarget = null)} class="px-4 py-2 text-sm text-slate-700 dark:text-slate-300">Cancel</button>
    <button onclick={handleRollback} disabled={rolling} class="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50">
      {rolling ? 'Rolling back…' : 'Confirm Rollback'}
    </button>
  {/snippet}
</Modal>
