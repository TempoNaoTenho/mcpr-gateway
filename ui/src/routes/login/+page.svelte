<script lang="ts">
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { onMount } from 'svelte';
  import { auth } from '$lib/auth.js';
  import { ApiError, authConfig } from '$lib/api.js';

  let username = $state('mcpgateway');
  let password = $state('');
  let passwordRequired = $state(true);
  let configReady = $state(false);
  let error = $state('');
  let loading = $state(false);

  onMount(async () => {
    try {
      const cfg = await authConfig();
      username = cfg.username;
      passwordRequired = cfg.passwordRequired;
    } catch {
      // Fallback: assume password required (server unreachable or pre-change gateway).
    } finally {
      configReady = true;
    }
  });

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (passwordRequired && !password.trim()) return;
    loading = true;
    error = '';
    try {
      await auth.login(username, password.trim());
      goto(`${base}/dashboard`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        error = 'Invalid credentials. Please try again.';
      } else if (err instanceof ApiError && err.status === 500) {
        error = 'Server configuration error. Contact administrator.';
      } else {
        error = 'Connection error. Is the gateway running?';
      }
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Login — MCPR Gateway</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
  <div class="w-full max-w-sm">
    <!-- Logo -->
    <div class="flex flex-col items-center mb-8">
      <div class="w-12 h-12 rounded-xl bg-indigo-600 flex items-center justify-center mb-4 shadow-lg">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 6h16M4 12h11M4 18h8" stroke="white" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <h1 class="text-xl font-semibold text-slate-900 dark:text-white">MCPR Gateway</h1>
      <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">Admin Console</p>
    </div>

    <!-- Form -->
    <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
      {#if !configReady}
        <div class="flex justify-center py-8">
          <div class="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {:else}
        <form onsubmit={handleSubmit}>
          <div class="mb-4">
            <label for="username" class="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              autocomplete="username"
              readonly
              class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 cursor-not-allowed"
            />
          </div>

          {#if passwordRequired}
            <div class="mb-4">
              <label for="password" class="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Password
              </label>
              <input
                id="password"
                type="password"
                bind:value={password}
                placeholder="Enter admin password"
                autocomplete="current-password"
                class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors"
              />
            </div>
          {:else}
            <p class="text-sm text-slate-600 dark:text-slate-400 mb-4">
              No password is configured on the gateway. Sign in with the username above only.
            </p>
          {/if}

          {#if error}
            <p class="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>
          {/if}

          <button
            type="submit"
            disabled={loading || (passwordRequired && !password.trim())}
            class="w-full py-2 px-4 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 dark:disabled:bg-indigo-800 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
          >
            {#if loading}
              <span class="flex items-center justify-center gap-2">
                <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                Authenticating...
              </span>
            {:else}
              Sign In
            {/if}
          </button>
        </form>
      {/if}
    </div>

    <p class="text-center text-xs text-slate-400 dark:text-slate-600 mt-4">
      Set <code class="font-mono bg-slate-100 dark:bg-slate-800 px-1 rounded">GATEWAY_ADMIN_PASSWORD</code> to require a password for this user. Override the default username with
      <code class="font-mono bg-slate-100 dark:bg-slate-800 px-1 rounded">GATEWAY_ADMIN_USER</code>.
    </p>
  </div>
</div>
