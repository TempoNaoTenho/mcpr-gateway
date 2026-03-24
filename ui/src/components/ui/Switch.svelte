<script lang="ts">
  type Props = {
    checked: boolean;
    ariaLabel: string;
    onchange: (next: boolean) => void;
    disabled?: boolean;
  };

  let { checked, ariaLabel, onchange, disabled = false }: Props = $props();
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={ariaLabel}
  disabled={disabled}
  onclick={() => {
    if (!disabled) onchange(!checked);
  }}
  class="relative inline-block h-5 w-9 shrink-0 rounded-full border border-slate-300 dark:border-slate-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 {disabled
    ? 'cursor-not-allowed opacity-50'
    : 'cursor-pointer'} {checked
    ? 'bg-indigo-600 border-indigo-600'
    : 'bg-slate-200 dark:bg-slate-700'}"
>
  <span
    class="pointer-events-none absolute top-0.5 left-0.5 block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ease-out {checked ? 'translate-x-4' : 'translate-x-0'}"
  ></span>
</button>
