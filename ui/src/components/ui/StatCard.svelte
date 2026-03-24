<script lang="ts">
  import InfoTooltip from './InfoTooltip.svelte';

  interface Props {
    label: string;
    value: number | string;
    delta?: string;
    deltaPositive?: boolean;
    hint?: string;
    icon?: import('svelte').ComponentType;
    color?: 'default' | 'success' | 'warning' | 'danger' | 'info';
    /** Extra classes for the value line (e.g. long URLs). */
    valueClass?: string;
  }

  let {
    label,
    value,
    delta,
    deltaPositive,
    hint,
    icon: Icon,
    color = 'default',
    valueClass = '',
  }: Props = $props();

  const iconColor = {
    default: 'text-slate-500 bg-slate-100 dark:bg-slate-800',
    success: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950',
    warning: 'text-amber-600 bg-amber-50 dark:bg-amber-950',
    danger: 'text-red-600 bg-red-50 dark:bg-red-950',
    info: 'text-indigo-600 bg-indigo-50 dark:bg-indigo-950',
  };
</script>

<div class="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5">
  <div class="flex items-start justify-between">
    <div>
      <div class="flex items-center gap-1">
        <p class="text-sm text-slate-500 dark:text-slate-400 font-medium">{label}</p>
        {#if hint}<InfoTooltip text={hint} />{/if}
      </div>
      <p
        class="text-2xl font-semibold text-slate-900 dark:text-white mt-1 break-words {valueClass}"
      >{value}</p>
      {#if delta}
        <p class="text-xs mt-1 {deltaPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}">
          {delta}
        </p>
      {/if}
    </div>
    {#if Icon}
      <div class="p-2 rounded-lg {iconColor[color]}">
        <Icon size={20} />
      </div>
    {/if}
  </div>
</div>
