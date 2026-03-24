<script lang="ts">
  interface Props {
    status: 'healthy' | 'degraded' | 'offline' | 'unknown';
    label?: boolean;
  }

  let { status, label = true }: Props = $props();

  const statusConfig = {
    healthy:  { dot: 'bg-emerald-500', label: 'Healthy',  pulse: true },
    degraded: { dot: 'bg-amber-500',   label: 'Degraded', pulse: false },
    offline:  { dot: 'bg-red-500',     label: 'Offline',  pulse: false },
    unknown:  { dot: 'bg-slate-400',   label: 'Unknown',  pulse: false },
  };

  let cfg = $derived(statusConfig[status] ?? statusConfig.unknown);
</script>

<span class="inline-flex items-center gap-1.5">
  <span class="relative flex h-2 w-2">
    {#if cfg.pulse}
      <span class="animate-ping absolute inline-flex h-full w-full rounded-full {cfg.dot} opacity-75"></span>
    {/if}
    <span class="relative inline-flex rounded-full h-2 w-2 {cfg.dot}"></span>
  </span>
  {#if label}
    <span class="text-sm text-slate-600 dark:text-slate-400">{cfg.label}</span>
  {/if}
</span>
