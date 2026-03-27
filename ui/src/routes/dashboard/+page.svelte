<script lang="ts">
  import { browser } from '$app/environment';
  import { onMount } from 'svelte';
  import { Activity, Globe, Wrench, AlertCircle, Monitor, Server } from 'lucide-svelte';
  import { getDashboard, type DashboardData } from '$lib/api.js';
  import { notifications } from '$lib/stores/notifications.js';
  import StatCard from '../../components/ui/StatCard.svelte';
  import StatusDot from '../../components/ui/StatusDot.svelte';
  import Badge from '../../components/ui/Badge.svelte';

  let data = $state<DashboardData | null>(null);
  let loading = $state(true);
  let uiOrigin = $state('');

  onMount(async () => {
    try {
      data = await getDashboard();
    } catch {
      notifications.error('Failed to load dashboard data');
    } finally {
      loading = false;
    }
  });

  $effect(() => {
    if (browser) uiOrigin = window.location.origin;
  });

  function formatGatewayListen(g: DashboardData['gateway']): string {
    const h = g.listenHost;
    const p = g.listenPort;
    if (h.includes(':') && !h.startsWith('[')) {
      return `[${h}]:${p}`;
    }
    return `${h}:${p}`;
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString();
  }

  const eventTypeVariant: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'muted'> = {
    session_created: 'info',
    tool_executed: 'success',
    execution_denied: 'danger',
    downstream_marked_unhealthy: 'warning',
    bootstrap_window_published: 'info',
    active_window_recomputed: 'muted',
  };

  function hasRegisteredServers(data: DashboardData) {
    return data.servers.total > 0;
  }
</script>

<svelte:head>
  <title>Dashboard — MCPR Gateway</title>
</svelte:head>

<div class="space-y-6">
  <div>
    <h1 class="text-xl font-semibold text-slate-900 dark:text-white">Dashboard</h1>
    <p class="text-sm text-slate-500 dark:text-slate-400 mt-0.5">Gateway overview and health status</p>
  </div>

  <!-- Stats Grid -->
  {#if loading}
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {#each { length: 4 } as _}
        <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5 h-24 animate-pulse">
          <div class="h-3 bg-slate-200 dark:bg-slate-700 rounded w-1/2 mb-3"></div>
          <div class="h-7 bg-slate-200 dark:bg-slate-700 rounded w-1/3"></div>
        </div>
      {/each}
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {#each { length: 2 } as _}
        <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5 h-24 animate-pulse">
          <div class="h-3 bg-slate-200 dark:bg-slate-700 rounded w-1/2 mb-3"></div>
          <div class="h-7 bg-slate-200 dark:bg-slate-700 rounded w-2/3"></div>
        </div>
      {/each}
    </div>
  {:else if data}
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        label="Active Sessions"
        value={data.sessions.active}
        delta="{data.sessions.total} total"
        icon={Activity}
        color="info"
      />
      <StatCard
        label="Healthy Servers"
        value={data.servers.healthy}
        delta="{data.servers.degraded} degraded, {data.servers.offline} offline"
        deltaPositive={data.servers.degraded === 0 && data.servers.offline === 0}
        icon={Globe}
        color="success"
      />
      <StatCard
        label="Total Tools"
        value={data.tools.total}
        delta={data.tools.quarantined > 0 ? `${data.tools.quarantined} quarantined` : 'all clear'}
        deltaPositive={data.tools.quarantined === 0}
        icon={Wrench}
        color="default"
      />
      <StatCard
        label="Error Rate (1h)"
        value="{(data.errorRate1h * 100).toFixed(1)}%"
        deltaPositive={data.errorRate1h < 0.05}
        icon={AlertCircle}
        color={data.errorRate1h > 0.1 ? 'danger' : data.errorRate1h > 0.05 ? 'warning' : 'success'}
      />
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <StatCard
        label="Browser (this page)"
        value={uiOrigin || '—'}
        hint="Browser origin. If the port differs from the gateway listen port, a proxy (e.g. Vite) is in front."
        icon={Monitor}
        color="info"
        valueClass="!text-lg"
      />
      <StatCard
        label="Gateway HTTP listen"
        value={formatGatewayListen(data.gateway)}
        hint="Actual address and port the gateway process is listening on."
        icon={Server}
        color="default"
        valueClass="!text-lg"
      />
    </div>

    {#if !hasRegisteredServers(data)}
      <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5">
        <h2 class="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">First run</h2>
        <p class="text-sm text-slate-500 dark:text-slate-400">
          The gateway is running with no downstream servers yet. Use the Servers panel to register the first downstream server without editing <code class="text-xs">bootstrap.json</code>.
        </p>
      </div>
    {:else if data.servers.healthy + data.servers.degraded + data.servers.offline > 0}
      <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5">
        <h2 class="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">Server Health</h2>
        <div class="flex flex-wrap gap-6">
          <div class="flex items-center gap-2">
            <StatusDot status="healthy" label={false} />
            <span class="text-sm text-slate-600 dark:text-slate-400">{data.servers.healthy} healthy</span>
          </div>
          <div class="flex items-center gap-2">
            <StatusDot status="degraded" label={false} />
            <span class="text-sm text-slate-600 dark:text-slate-400">{data.servers.degraded} degraded</span>
          </div>
          <div class="flex items-center gap-2">
            <StatusDot status="offline" label={false} />
            <span class="text-sm text-slate-600 dark:text-slate-400">{data.servers.offline} offline</span>
          </div>
        </div>
      </div>
    {/if}

    <!-- Recent Events -->
    {#if data.recentEvents.length > 0}
      <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5">
        <h2 class="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">Recent Events</h2>
        <div class="space-y-2">
          {#each data.recentEvents as event}
            <div class="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
              <div class="flex items-center gap-3">
                <Badge variant={eventTypeVariant[event.type] ?? 'muted'}>
                  {event.type.replace(/_/g, ' ')}
                </Badge>
                <span class="text-sm text-slate-600 dark:text-slate-400">
                  {event.sessionId ?? event.serverId ?? ''}
                </span>
              </div>
              <span class="text-xs text-slate-400 dark:text-slate-600 shrink-0">{formatTime(event.timestamp)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
