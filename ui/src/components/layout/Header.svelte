<script lang="ts">
  import { Moon, Sun, LogOut } from 'lucide-svelte';
  import { theme } from '$lib/stores/theme.js';
  import { auth } from '$lib/auth.js';
  import { page } from '$app/stores';

  const breadcrumbMap: Record<string, string> = {
    dashboard: 'Dashboard',
    sessions: 'Sessions',
    servers: 'Servers',
    tools: 'Tools',
    audit: 'Audit Logs',
    config: 'Configuration',
    access: 'Access Control',
    docs: 'Docs',
  };

  let isDark = $derived($theme === 'dark');

  let breadcrumb = $derived(() => {
    const parts = $page.url.pathname.replace(/^\/ui/, '').split('/').filter(Boolean);
    return parts.map((p) => breadcrumbMap[p] ?? p);
  });
</script>

<header class="h-14 flex items-center justify-between px-6 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
  <!-- Breadcrumb -->
  <nav class="flex items-center gap-1.5 text-sm">
    <span class="text-slate-400 dark:text-slate-500">Gateway</span>
    {#each breadcrumb() as crumb}
      <span class="text-slate-300 dark:text-slate-600">/</span>
      <span class="text-slate-700 dark:text-slate-300 font-medium">{crumb}</span>
    {/each}
  </nav>

  <!-- Actions -->
  <div class="flex items-center gap-2">
    <button
      onclick={() => theme.toggle()}
      class="p-2 rounded-lg text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
      aria-label="Toggle theme"
    >
      {#if isDark}
        <Sun size={16} />
      {:else}
        <Moon size={16} />
      {/if}
    </button>

    <button
      onclick={() => auth.logout()}
      class="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-600 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 rounded-lg transition-colors"
    >
      <LogOut size={14} />
      Logout
    </button>
  </div>
</header>
