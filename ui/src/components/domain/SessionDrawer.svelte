<script lang="ts">
  import { X, Wrench, Clock } from 'lucide-svelte';
  import Badge from '$components/ui/Badge.svelte';
  import type { SessionState } from '$lib/api.js';

  interface Props {
    session: SessionState | null;
    onclose: () => void;
    onRevoke?: (id: string) => void;
  }

  let { session, onclose, onRevoke }: Props = $props();

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString();
  }

  const statusVariant = {
    active: 'success' as const,
    cold: 'info' as const,
    expired: 'muted' as const,
    revoked: 'danger' as const,
  };
</script>

<!-- Backdrop -->
{#if session}
  <div
    class="fixed inset-0 z-30 bg-black/30"
    onclick={onclose}
    role="presentation"
  ></div>

  <!-- Drawer -->
  <aside class="fixed right-0 top-0 bottom-0 z-40 w-96 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 flex flex-col shadow-xl overflow-hidden">
    <!-- Header -->
    <div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
      <div>
        <p class="font-semibold text-slate-900 dark:text-white text-sm">Session Detail</p>
        <p class="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">{session.id}</p>
      </div>
      <button
        onclick={onclose}
        class="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
      >
        <X size={16} />
      </button>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-y-auto px-5 py-4 space-y-5">
      <!-- Meta -->
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">Status</p>
          <Badge variant={statusVariant[session.status] ?? 'muted'}>{session.status}</Badge>
        </div>
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">Mode</p>
          <span class="font-medium text-slate-700 dark:text-slate-300">{session.mode}</span>
        </div>
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">User</p>
          <span class="font-medium text-slate-700 dark:text-slate-300 font-mono text-xs">{session.userId}</span>
        </div>
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">Namespace</p>
          <span class="font-medium text-slate-700 dark:text-slate-300">{session.namespace}</span>
        </div>
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">Created</p>
          <span class="text-xs text-slate-600 dark:text-slate-400">{formatDate(session.createdAt)}</span>
        </div>
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">Last Active</p>
          <span class="text-xs text-slate-600 dark:text-slate-400">{formatDate(session.lastActiveAt)}</span>
        </div>
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">Refresh Count</p>
          <span class="font-medium text-slate-700 dark:text-slate-300">{session.refreshCount}</span>
        </div>
      </div>

      <!-- Tool Window -->
      <div>
        <div class="flex items-center gap-2 mb-2">
          <Wrench size={14} class="text-slate-400" />
          <p class="text-sm font-medium text-slate-700 dark:text-slate-300">
            Tool Window ({session.toolWindow.length})
          </p>
        </div>
        {#if session.toolWindow.length === 0}
          <p class="text-xs text-slate-500 dark:text-slate-400">No tools in window</p>
        {:else}
          <div class="space-y-1.5">
            {#each session.toolWindow as tool}
              <div class="flex items-center justify-between py-1.5 px-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                <div>
                  <p class="text-xs font-medium text-slate-700 dark:text-slate-300">{tool.name}</p>
                  {#if tool.description}
                    <p class="text-xs text-slate-500 dark:text-slate-500 truncate max-w-52">{tool.description}</p>
                  {/if}
                </div>
                {#if tool.riskLevel}
                  <Badge variant={tool.riskLevel === 'high' ? 'danger' : tool.riskLevel === 'medium' ? 'warning' : 'success'}>
                    {tool.riskLevel}
                  </Badge>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Refresh History -->
      {#if session.refreshHistory && session.refreshHistory.length > 0}
        <div>
          <div class="flex items-center gap-2 mb-2">
            <Clock size={14} class="text-slate-400" />
            <p class="text-sm font-medium text-slate-700 dark:text-slate-300">Refresh History</p>
          </div>
          <div class="space-y-1.5">
            {#each session.refreshHistory.slice().reverse() as entry}
              <div class="flex items-center justify-between text-xs py-1 px-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                <span class="text-slate-600 dark:text-slate-400">{entry.triggeredBy}</span>
                <span class="text-slate-500">{entry.toolCount} tools · {new Date(entry.timestamp).toLocaleTimeString()}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <!-- Footer -->
    {#if session.status === 'active' && onRevoke}
      <div class="px-5 py-4 border-t border-slate-200 dark:border-slate-800">
        <button
          onclick={() => onRevoke!(session!.id)}
          class="w-full px-4 py-2 text-sm font-medium text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950 hover:bg-red-100 dark:hover:bg-red-900 border border-red-200 dark:border-red-800 rounded-lg transition-colors"
        >
          Revoke Session
        </button>
      </div>
    {/if}
  </aside>
{/if}
