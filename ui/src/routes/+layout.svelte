<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import { auth } from '$lib/auth.js';
  import Sidebar from '../components/layout/Sidebar.svelte';
  import Header from '../components/layout/Header.svelte';
  import Toast from '../components/ui/Toast.svelte';

  interface Props {
    children: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  let isLoginPage = $derived($page.url.pathname === `${base}/login` || $page.url.pathname === `${base}/`);
  let authChecked = $state(false);

  onMount(async () => {
    await auth.check();
    authChecked = true;
  });

  // Layout `onMount` only runs once; pathname-driven redirects must react to client navigations
  // (e.g. browser back from `/dashboard` to `/`) so we do not leave an empty root `+page.svelte`.
  $effect(() => {
    if (!authChecked) return;
    const pathname = $page.url.pathname;
    const ok = $auth.authenticated;
    const onLogin = pathname === `${base}/login`;
    const onRoot = pathname === `${base}/`;
    if (!ok && !onLogin) {
      void goto(`${base}/login`, { replaceState: true });
    } else if (ok && (onLogin || onRoot)) {
      void goto(`${base}/dashboard`, { replaceState: true });
    }
  });
</script>

{#if !authChecked}
  <div class="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
    <div class="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
  </div>
{:else if isLoginPage}
  {@render children()}
{:else}
  <div class="flex min-h-screen">
    <Sidebar />
    <div class="relative z-10 flex min-w-0 flex-1 flex-col">
      <Header />
      <main class="flex-1 p-6 overflow-y-auto">
        {@render children()}
      </main>
    </div>
  </div>
{/if}

<Toast />
