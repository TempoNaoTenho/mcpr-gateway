<script lang="ts">
  import { notifications } from '$lib/stores/notifications.js';
  import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-svelte';
  import type { ToastType } from '$lib/stores/notifications.js';

  const colorMap: Record<ToastType, string> = {
    success: 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950',
    error: 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950',
    info: 'border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950',
    warning: 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950',
  };

  const textMap: Record<ToastType, string> = {
    success: 'text-emerald-800 dark:text-emerald-200',
    error: 'text-red-800 dark:text-red-200',
    info: 'text-indigo-800 dark:text-indigo-200',
    warning: 'text-amber-800 dark:text-amber-200',
  };
</script>

<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
  {#each $notifications as toast (toast.id)}
    <div
      class="pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg min-w-72 max-w-sm {colorMap[toast.type]}"
    >
      <!-- Icon by type -->
      {#if toast.type === 'success'}
        <CheckCircle size={16} class="shrink-0 mt-0.5 {textMap[toast.type]}" />
      {:else if toast.type === 'error'}
        <XCircle size={16} class="shrink-0 mt-0.5 {textMap[toast.type]}" />
      {:else if toast.type === 'warning'}
        <AlertTriangle size={16} class="shrink-0 mt-0.5 {textMap[toast.type]}" />
      {:else}
        <Info size={16} class="shrink-0 mt-0.5 {textMap[toast.type]}" />
      {/if}
      <p class="text-sm flex-1 {textMap[toast.type]}">{toast.message}</p>
      <button
        onclick={() => notifications.remove(toast.id)}
        class="shrink-0 {textMap[toast.type]} opacity-60 hover:opacity-100 transition-opacity"
      >
        <X size={14} />
      </button>
    </div>
  {/each}
</div>
