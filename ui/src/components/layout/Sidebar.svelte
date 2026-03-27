<script lang="ts">
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import {
    LayoutDashboard,
    Globe,
    Wrench,
    ScrollText,
    Settings,
    ShieldCheck,
    Activity,
    BookOpen,
    Layers3,
  } from 'lucide-svelte';

  const navItems = [
    { href: `${base}/dashboard`, label: 'Dashboard', icon: LayoutDashboard },
    { href: `${base}/sessions`, label: 'Sessions', icon: Activity },
    { href: `${base}/servers`, label: 'Servers', icon: Globe },
    { href: `${base}/tools`, label: 'Tools', icon: Wrench },
    { href: `${base}/namespaces`, label: 'Namespaces', icon: Layers3 },
    { href: `${base}/audit`, label: 'Audit Logs', icon: ScrollText },
    { href: `${base}/config`, label: 'Config', icon: Settings },
    { href: `${base}/access`, label: 'Access Control', icon: ShieldCheck },
    { href: `${base}/docs`, label: 'Docs', icon: BookOpen },
  ];

  function isActive(href: string): boolean {
    return $page.url.pathname === href || $page.url.pathname.startsWith(href + '/');
  }
</script>

<aside
  class="relative z-0 w-60 shrink-0 flex flex-col bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 min-h-screen"
>
  <!-- Logo -->
  <div class="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
    <div class="flex items-center gap-2.5">
      <div class="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 4h10M3 8h7M3 12h5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </div>
      <div>
        <p class="text-sm font-semibold text-slate-900 dark:text-white leading-tight">MCPR Gateway</p>
        <p class="text-xs text-slate-500 dark:text-slate-400">Session Manager</p>
      </div>
    </div>
  </div>

  <!-- Navigation -->
  <nav class="flex-1 px-3 py-4 space-y-0.5">
    {#each navItems as item}
      {@const active = isActive(item.href)}
      <a
        href={item.href}
        class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors
          {active
            ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300'
            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100'}"
      >
        <item.icon size={16} class="shrink-0" />
        {item.label}
      </a>
    {/each}
  </nav>

  <!-- Footer -->
  <div class="px-4 py-3 border-t border-slate-200 dark:border-slate-800">
    <p class="text-xs text-slate-400 dark:text-slate-600">v1.0 — MCPR Gateway</p>
  </div>
</aside>
