<script lang="ts">
  interface Props {
    variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'muted';
    size?: 'sm' | 'md';
    children: import('svelte').Snippet;
  }

  let { variant = 'default', size = 'sm', children }: Props = $props();

  const variantClass = {
    default: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
    success: 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300',
    warning: 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300',
    danger: 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300',
    info: 'bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300',
    muted: 'bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-500',
  };

  const sizeClass = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-2.5 py-1 text-sm',
  };
</script>

<span class="inline-flex items-center font-medium rounded-full {variantClass[variant]} {sizeClass[size]}">
  {@render children()}
</span>
