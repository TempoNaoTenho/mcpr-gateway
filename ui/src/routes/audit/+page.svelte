<script lang="ts">
  import { onMount } from 'svelte';
  import { getAuditLogs, pruneAuditLogs, type AuditEvent } from '$lib/api.js';
  import { notifications } from '$lib/stores/notifications.js';
  import Badge from '../../components/ui/Badge.svelte';
  import Modal from '../../components/ui/Modal.svelte';

  let events = $state<AuditEvent[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let page = $state(0);
  const limit = 25;

  // Filters
  let typeFilter = $state('');
  let sessionIdFilter = $state('');
  let userIdFilter = $state('');
  let fromFilter = $state('');
  let toFilter = $state('');

  // Prune modal
  let pruneOpen = $state(false);
  let pruneDays = $state(90);
  let pruning = $state(false);

  // Expand event
  let expanded = $state<number | null>(null);

  async function load() {
    loading = true;
    try {
      const res = await getAuditLogs({
        event_type: typeFilter || undefined,
        session_id: sessionIdFilter || undefined,
        user_id: userIdFilter || undefined,
        from: fromFilter || undefined,
        to: toFilter || undefined,
        limit,
        offset: page * limit,
      });
      events = res.events;
      total = res.total;
    } catch {
      notifications.error('Failed to load audit logs');
    } finally {
      loading = false;
    }
  }

  async function doPrune() {
    pruning = true;
    try {
      const res = await pruneAuditLogs(pruneDays);
      notifications.success(`Deleted ${res.deleted} events older than ${pruneDays} days`);
      pruneOpen = false;
      load();
    } catch {
      notifications.error('Failed to prune audit logs');
    } finally {
      pruning = false;
    }
  }

  onMount(load);

  const typeVariant: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'muted'> = {
    session_created: 'info',
    tool_executed: 'success',
    execution_denied: 'danger',
    downstream_marked_unhealthy: 'warning',
    bootstrap_window_published: 'info',
    active_window_recomputed: 'muted',
  };

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString();
  }
</script>

<svelte:head>
  <title>Audit Logs — MCP Gateway</title>
</svelte:head>

<div class="space-y-5">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold text-slate-900 dark:text-white">Audit Logs</h1>
      <p class="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{total} events</p>
    </div>
    <button
      onclick={() => (pruneOpen = true)}
      class="px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950 hover:bg-red-100 dark:hover:bg-red-900 border border-red-200 dark:border-red-800 rounded-lg transition-colors"
    >
      Prune Old Logs
    </button>
  </div>

  <!-- Filters -->
  <div class="flex flex-wrap gap-3">
    <select
      bind:value={typeFilter}
      onchange={() => { page = 0; load(); }}
      class="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    >
      <option value="">All event types</option>
      <option value="session_created">Session Created</option>
      <option value="tool_executed">Tool Executed</option>
      <option value="execution_denied">Execution Denied</option>
      <option value="downstream_marked_unhealthy">Server Unhealthy</option>
      <option value="bootstrap_window_published">Bootstrap Published</option>
      <option value="active_window_recomputed">Window Recomputed</option>
    </select>

    <input
      type="text"
      bind:value={sessionIdFilter}
      placeholder="Session ID…"
      oninput={() => { page = 0; load(); }}
      class="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-44"
    />

    <input
      type="text"
      bind:value={userIdFilter}
      placeholder="User ID…"
      oninput={() => { page = 0; load(); }}
      class="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-36"
    />

    <input
      type="datetime-local"
      bind:value={fromFilter}
      onchange={() => { page = 0; load(); }}
      class="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    />
  </div>

  <!-- Table -->
  <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Event</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Session</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">User</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Details</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Time</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
        {#if loading}
          {#each { length: 6 } as _}
            <tr>
              {#each { length: 5 } as _}
                <td class="px-4 py-3">
                  <div class="h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse w-3/4"></div>
                </td>
              {/each}
            </tr>
          {/each}
        {:else if events.length === 0}
          <tr>
            <td colspan="5" class="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
              No audit events found
            </td>
          </tr>
        {:else}
          {#each events as event, i}
            <tr
              class="hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors"
              onclick={() => (expanded = expanded === i ? null : i)}
            >
              <td class="px-4 py-3">
                <Badge variant={typeVariant[event.type] ?? 'muted'}>
                  {event.type.replace(/_/g, ' ')}
                </Badge>
              </td>
              <td class="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                {event.sessionId ? event.sessionId.slice(0, 10) + '…' : event.serverId ?? '—'}
              </td>
              <td class="px-4 py-3 text-slate-600 dark:text-slate-400 text-xs">{event.userId ?? '—'}</td>
              <td class="px-4 py-3 text-slate-600 dark:text-slate-400 text-xs">
                {#if event.toolName}
                  <span class="font-mono">{event.toolName}</span>
                  {#if event.outcome}· {event.outcome}{/if}
                  {#if event.latencyMs !== undefined}· {event.latencyMs}ms{/if}
                {:else if event.reason}
                  {event.reason}
                {:else if event.toolCount !== undefined}
                  {event.toolCount} tools
                {/if}
              </td>
              <td class="px-4 py-3 text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">
                {formatDate(event.timestamp)}
              </td>
            </tr>
            {#if expanded === i && event.payload}
              <tr class="bg-slate-50 dark:bg-slate-800/50">
                <td colspan="5" class="px-4 py-3">
                  <pre class="text-xs text-slate-600 dark:text-slate-400 overflow-x-auto bg-white dark:bg-slate-900 rounded-lg p-3 border border-slate-200 dark:border-slate-700">{JSON.stringify(event.payload, null, 2)}</pre>
                </td>
              </tr>
            {/if}
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  <!-- Pagination -->
  {#if total > limit}
    <div class="flex items-center justify-between text-sm text-slate-600 dark:text-slate-400">
      <span>Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}</span>
      <div class="flex gap-2">
        <button
          onclick={() => { page--; load(); }}
          disabled={page === 0}
          class="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
        >
          Previous
        </button>
        <button
          onclick={() => { page++; load(); }}
          disabled={(page + 1) * limit >= total}
          class="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  {/if}
</div>

<!-- Prune Modal -->
<Modal open={pruneOpen} title="Prune Audit Logs" onclose={() => (pruneOpen = false)}>
  {#snippet children()}
    <div class="space-y-4">
      <p class="text-sm text-slate-600 dark:text-slate-400">
        Delete all audit events older than the specified number of days. This cannot be undone.
      </p>
      <div>
        <label for="prune-days" class="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
          Retention (days)
        </label>
        <input
          id="prune-days"
          type="number"
          bind:value={pruneDays}
          min="1"
          max="3650"
          class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
    </div>
  {/snippet}
  {#snippet footer()}
    <button
      onclick={() => (pruneOpen = false)}
      class="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
    >
      Cancel
    </button>
    <button
      onclick={doPrune}
      disabled={pruning}
      class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors"
    >
      {pruning ? 'Pruning…' : `Delete logs older than ${pruneDays} days`}
    </button>
  {/snippet}
</Modal>
