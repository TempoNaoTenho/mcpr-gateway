<script lang="ts">
  let {
    options = [],
    value = $bindable<string[]>([]),
    placeholder = 'Add namespace...',
  }: {
    options?: string[];
    value?: string[];
    placeholder?: string;
  } = $props();

  let inputValue = $state('');
  let open = $state(false);

  const filtered = $derived(
    options.filter(
      (o) => !value.includes(o) && o.toLowerCase().includes(inputValue.toLowerCase()),
    ),
  );

  function add(ns: string) {
    if (!value.includes(ns)) value = [...value, ns];
    inputValue = '';
    open = false;
  }

  function remove(ns: string) {
    value = value.filter((v) => v !== ns);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      add(inputValue.trim());
    }
    if (e.key === 'Escape') open = false;
  }
</script>

<div class="flex flex-wrap gap-1.5">
  {#each value as ns}
    <span
      class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/30 text-sm font-medium text-indigo-700 dark:text-indigo-300"
    >
      {ns}
      <button
        type="button"
        onclick={() => remove(ns)}
        class="ml-0.5 text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-100 leading-none"
        aria-label="Remove {ns}"
      >
        ×
      </button>
    </span>
  {/each}

  <div class="relative">
    <input
      bind:value={inputValue}
      onfocus={() => (open = true)}
      onblur={() => setTimeout(() => (open = false), 150)}
      onkeydown={handleKeydown}
      {placeholder}
      autocomplete="off"
      class="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 min-w-40"
    />
    {#if open && (filtered.length > 0 || inputValue.trim())}
      <ul
        class="absolute top-full mt-1 w-full z-20 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg max-h-48 overflow-y-auto"
      >
        {#each filtered as ns}
          <li>
            <button
              type="button"
              onmousedown={(e) => { e.preventDefault(); add(ns); }}
              class="w-full px-3 py-2 text-sm text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              {ns}
            </button>
          </li>
        {/each}
        {#if inputValue.trim() && !options.includes(inputValue.trim())}
          <li>
            <button
              type="button"
              onmousedown={(e) => { e.preventDefault(); add(inputValue.trim()); }}
              class="w-full px-3 py-2 text-sm text-left text-indigo-600 dark:text-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Create "{inputValue.trim()}"
            </button>
          </li>
        {/if}
      </ul>
    {/if}
  </div>
</div>
