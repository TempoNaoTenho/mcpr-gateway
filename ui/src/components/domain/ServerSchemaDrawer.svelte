<script lang="ts">
  import { X } from 'lucide-svelte';
  import Badge from '$components/ui/Badge.svelte';
  import JsonSchemaEditor from '$components/domain/JsonSchemaEditor.svelte';
  import type { ServerSchemaDetail } from '$lib/api.js';

  interface Props {
    detail: ServerSchemaDetail | null;
    onclose: () => void;
  }

  let { detail, onclose }: Props = $props();

  const healthVariant = {
    healthy: 'success' as const,
    degraded: 'warning' as const,
    offline: 'danger' as const,
    unknown: 'muted' as const,
  };
</script>

{#if detail}
  <div class="fixed inset-0 z-30 bg-black/30" onclick={onclose} role="presentation"></div>

  <aside class="fixed right-0 top-0 bottom-0 z-40 w-[42rem] max-w-full bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 flex flex-col shadow-xl overflow-hidden">
    <div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
      <div>
        <p class="font-semibold text-slate-900 dark:text-white text-sm">Server schema</p>
        <p class="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">{detail.server.id}</p>
      </div>
      <button
        onclick={onclose}
        class="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
      >
        <X size={16} />
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-5 py-4 space-y-5">
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">Health</p>
          <Badge variant={healthVariant[detail.server.health as keyof typeof healthVariant] ?? 'muted'}>
            {detail.server.health}
          </Badge>
        </div>
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">Transport</p>
          <span class="font-medium text-slate-700 dark:text-slate-300">{detail.server.transport}</span>
        </div>
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">Namespaces</p>
          <div class="flex gap-1.5 flex-wrap">
            {#each detail.server.namespaces as ns}
              <Badge variant="info">{ns}</Badge>
            {/each}
          </div>
        </div>
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">Trust</p>
          <span class="font-medium text-slate-700 dark:text-slate-300">{detail.server.trustLevel}</span>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/60 px-3 py-3">
          <p class="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Tools</p>
          <p class="mt-1 text-lg font-semibold text-slate-900 dark:text-white">{detail.summary.toolCount}</p>
        </div>
        <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/60 px-3 py-3">
          <p class="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Schema tokens</p>
          <p class="mt-1 text-lg font-semibold text-slate-900 dark:text-white">~{detail.summary.schemaTokens}</p>
        </div>
        <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/60 px-3 py-3">
          <p class="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Context tokens</p>
          <p class="mt-1 text-lg font-semibold text-slate-900 dark:text-white">~{detail.summary.totalTokens}</p>
        </div>
        <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/60 px-3 py-3">
          <p class="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Customized</p>
          <p class="mt-1 text-lg font-semibold text-slate-900 dark:text-white">{detail.summary.customizedTools}</p>
        </div>
      </div>

      <div class="space-y-2">
        <p class="text-sm font-medium text-slate-700 dark:text-slate-300">Tools</p>
        {#if detail.tools.length === 0}
          <div class="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 px-4 py-6 text-sm text-slate-500 dark:text-slate-400">
            No tools available for this server.
          </div>
        {:else}
          <div class="space-y-2">
            {#each detail.tools as tool}
              <details class="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden group">
                <summary class="list-none cursor-pointer px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="font-medium text-slate-900 dark:text-white font-mono text-xs">{tool.name}</p>
                      <p class="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate">{tool.effectiveDescription ?? 'No description'}</p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      {#if tool.customized}
                        <Badge variant="warning">customized</Badge>
                      {/if}
                      <Badge variant="muted">~{tool.totalTokens} tokens</Badge>
                    </div>
                  </div>
                </summary>
                <div class="border-t border-slate-200 dark:border-slate-800 px-4 py-3 space-y-3">
                  <div class="grid grid-cols-2 gap-3 text-xs text-slate-500 dark:text-slate-400">
                    <div>Schema tokens: ~{tool.schemaTokens}</div>
                    <div>Total context tokens: ~{tool.totalTokens}</div>
                  </div>
                  <label class="space-y-1 block">
                    <span class="text-xs font-medium text-slate-500 dark:text-slate-400">Effective schema</span>
                    <JsonSchemaEditor
                      readOnly={true}
                      value={JSON.stringify(tool.effectiveInputSchema, null, 2)}
                      scrollerMinHeight="12rem"
                    />
                  </label>
                </div>
              </details>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </aside>
{/if}
