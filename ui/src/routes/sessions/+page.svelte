<script lang="ts">
  import { onMount } from 'svelte';
  import { getSessions, getSession, deleteSession, type SessionState } from '$lib/api.js';
  import { notifications } from '$lib/stores/notifications.js';
  import Badge from '../../components/ui/Badge.svelte';
  import Modal from '../../components/ui/Modal.svelte';
  import SessionDrawer from '../../components/domain/SessionDrawer.svelte';

  let sessions = $state<SessionState[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let statusFilter = $state('');
  let namespaceFilter = $state('');
  let selectedSession = $state<SessionState | null>(null);
  let revokeTarget = $state<SessionState | null>(null);
  let revoking = $state(false);
  let page = $state(0);
  const limit = 20;

  async function loadSessions() {
    loading = true;
    try {
      const res = await getSessions({
        status: statusFilter || undefined,
        namespace: namespaceFilter || undefined,
        limit,
        offset: page * limit,
      });
      sessions = res.sessions;
      total = res.total;
    } catch {
      notifications.error('Failed to load sessions');
    } finally {
      loading = false;
    }
  }

  async function openSession(id: string) {
    try {
      selectedSession = await getSession(id);
    } catch {
      notifications.error('Failed to load session details');
    }
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    revoking = true;
    try {
      await deleteSession(revokeTarget.id);
      notifications.success(`Session ${revokeTarget.id.slice(0, 8)}… revoked`);
      revokeTarget = null;
      selectedSession = null;
      loadSessions();
    } catch {
      notifications.error('Failed to revoke session');
    } finally {
      revoking = false;
    }
  }

  onMount(loadSessions);

  const statusVariant: Record<string, 'success' | 'info' | 'muted' | 'danger'> = {
    active: 'success',
    cold: 'info',
    expired: 'muted',
    revoked: 'danger',
  };

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString();
  }
</script>

<svelte:head>
  <title>Sessions — MCPR Gateway</title>
</svelte:head>

<div class="space-y-5">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold text-slate-900 dark:text-white">Sessions</h1>
      <p class="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{total} total sessions</p>
    </div>
  </div>

  <!-- Filters -->
  <div class="flex flex-wrap gap-3">
    <select
      autocomplete="off"
      bind:value={statusFilter}
      onchange={() => { page = 0; loadSessions(); }}
      class="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    >
      <option value="">All statuses</option>
      <option value="active">Active</option>
      <option value="cold">Cold</option>
      <option value="expired">Expired</option>
      <option value="revoked">Revoked</option>
    </select>

    <input
      type="text"
      autocomplete="off"
      bind:value={namespaceFilter}
      placeholder="Filter by namespace…"
      oninput={() => { page = 0; loadSessions(); }}
      class="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-52"
    />
  </div>

  <!-- Table -->
  <div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Session ID</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">User</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Namespace</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Status</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Tools</th>
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">Last Active</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
        {#if loading}
          {#each { length: 5 } as _}
            <tr>
              {#each { length: 6 } as _}
                <td class="px-4 py-3">
                  <div class="h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse w-3/4"></div>
                </td>
              {/each}
            </tr>
          {/each}
        {:else if sessions.length === 0}
          <tr>
            <td colspan="6" class="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
              No sessions found
            </td>
          </tr>
        {:else}
          {#each sessions as session}
            <tr
              class="hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors"
              onclick={() => openSession(session.id)}
            >
              <td class="px-4 py-3 font-mono text-xs text-slate-600 dark:text-slate-400">
                {session.id.slice(0, 12)}…
              </td>
              <td class="px-4 py-3 text-slate-700 dark:text-slate-300">{session.userId}</td>
              <td class="px-4 py-3 text-slate-700 dark:text-slate-300">{session.namespace}</td>
              <td class="px-4 py-3">
                <Badge variant={statusVariant[session.status] ?? 'muted'}>
                  {session.status}
                </Badge>
              </td>
              <td class="px-4 py-3 text-slate-600 dark:text-slate-400">{session.toolWindow.length}</td>
              <td class="px-4 py-3 text-slate-500 dark:text-slate-400 text-xs">{formatDate(session.lastActiveAt)}</td>
            </tr>
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
          onclick={() => { page--; loadSessions(); }}
          disabled={page === 0}
          class="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
        >
          Previous
        </button>
        <button
          onclick={() => { page++; loadSessions(); }}
          disabled={(page + 1) * limit >= total}
          class="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  {/if}
</div>

<!-- Session Detail Drawer -->
<SessionDrawer
  session={selectedSession}
  onclose={() => (selectedSession = null)}
  onRevoke={(id) => {
    revokeTarget = sessions.find((s) => s.id === id) ?? null;
  }}
/>

<!-- Revoke Confirmation Modal -->
<Modal
  open={revokeTarget !== null}
  title="Revoke Session"
  onclose={() => (revokeTarget = null)}
>
  {#snippet children()}
    <p class="text-sm text-slate-600 dark:text-slate-400">
      Are you sure you want to revoke session
      <code class="font-mono text-xs bg-slate-100 dark:bg-slate-800 px-1 rounded">{revokeTarget?.id.slice(0, 12)}…</code>?
      This action cannot be undone.
    </p>
  {/snippet}
  {#snippet footer()}
    <button
      onclick={() => (revokeTarget = null)}
      class="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
    >
      Cancel
    </button>
    <button
      onclick={confirmRevoke}
      disabled={revoking}
      class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors"
    >
      {revoking ? 'Revoking…' : 'Revoke'}
    </button>
  {/snippet}
</Modal>
