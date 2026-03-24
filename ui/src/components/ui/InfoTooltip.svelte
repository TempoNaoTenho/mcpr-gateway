<script lang="ts">
  import { Info } from 'lucide-svelte';
  import { tick } from 'svelte';

  interface Props {
    text: string;
    size?: number;
  }
  let { text, size = 13 } = $props();

  let anchorEl = $state<HTMLButtonElement | null>(null);
  let visible = $state(false);
  let pos = $state({ top: 0, left: 0 });

  function place() {
    if (!anchorEl || !visible) return;
    const r = anchorEl.getBoundingClientRect();
    const margin = 6;
    pos = {
      left: r.left + r.width / 2,
      top: r.top - margin,
    };
  }

  async function show() {
    visible = true;
    await tick();
    place();
  }

  function hide() {
    visible = false;
  }

  $effect(() => {
    if (!visible) return;
    const handler = () => place();
    document.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      document.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  });

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

<button
  type="button"
  bind:this={anchorEl}
  class="relative inline-flex cursor-help items-center border-0 bg-transparent p-0 align-middle"
  aria-label={text}
  onmouseenter={show}
  onmouseleave={hide}
>
  <Info size={size} class="text-slate-400 dark:text-slate-500" />
</button>

{#if visible}
  <div
    use:portal
    class="pointer-events-none fixed z-[48] w-max max-w-xs rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs leading-snug whitespace-normal text-white shadow-lg dark:bg-slate-700"
    style:left="{pos.left}px"
    style:top="{pos.top}px"
    style:transform="translate(-50%, -100%)"
  >
    {text}
  </div>
{/if}
