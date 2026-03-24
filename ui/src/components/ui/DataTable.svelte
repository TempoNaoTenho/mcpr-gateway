<script lang="ts" generics="T extends Record<string, unknown>">
  import { ChevronUp, ChevronDown } from 'lucide-svelte';

  interface Column<T> {
    key: keyof T | string;
    label: string;
    sortable?: boolean;
    render?: (row: T) => unknown;
  }

  interface Props {
    rows: T[];
    columns: Column<T>[];
    loading?: boolean;
    emptyMessage?: string;
    rowHref?: (row: T) => string;
  }

  let { rows, columns, loading = false, emptyMessage = 'No data', rowHref }: Props = $props();

  let sortKey = $state<string | null>(null);
  let sortDir = $state<'asc' | 'desc'>('asc');

  let sortedRows = $derived(() => {
    if (!sortKey) return rows;
    return [...rows].sort((a, b) => {
      const va = String(a[sortKey as keyof T] ?? '');
      const vb = String(b[sortKey as keyof T] ?? '');
      const cmp = va.localeCompare(vb);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  });

  function toggleSort(key: string) {
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = 'asc';
    }
  }
</script>

<div class="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
  <table class="w-full text-sm">
    <thead>
      <tr class="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
        {#each columns as col}
          <th class="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap">
            {#if col.sortable}
              <button
                class="flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                onclick={() => toggleSort(col.key as string)}
              >
                {col.label}
                {#if sortKey === col.key}
                  {#if sortDir === 'asc'}
                    <ChevronUp size={12} />
                  {:else}
                    <ChevronDown size={12} />
                  {/if}
                {/if}
              </button>
            {:else}
              {col.label}
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
      {#if loading}
        {#each { length: 5 } as _}
          <tr>
            {#each columns as _col}
              <td class="px-4 py-3">
                <div class="h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse w-3/4"></div>
              </td>
            {/each}
          </tr>
        {/each}
      {:else if sortedRows().length === 0}
        <tr>
          <td colspan={columns.length} class="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
            {emptyMessage}
          </td>
        </tr>
      {:else}
        {#each sortedRows() as row}
          <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors {rowHref ? 'cursor-pointer' : ''}">
            {#each columns as col}
              <td class="px-4 py-3 text-slate-700 dark:text-slate-300">
                {#if col.render}
                  {@html col.render(row)}
                {:else}
                  {row[col.key as keyof T] ?? '—'}
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>
