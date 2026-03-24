<svelte:head>
  <title>Docs — MCP Gateway</title>
</svelte:head>

<div class="space-y-6 max-w-3xl">
  <div>
    <h1 class="text-xl font-semibold text-slate-900 dark:text-white">Docs</h1>
    <p class="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
      Local development and networking for this UI and the gateway API.
    </p>
  </div>

  <section
    class="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3 text-sm text-slate-600 dark:text-slate-400"
  >
    <h2 class="text-sm font-semibold text-slate-800 dark:text-slate-200">npm run dev:all</h2>
    <p>
      The admin UI is served by Vite using the same
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">HOST</code>
      and
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">PORT</code> as in the project
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">.env</code>
      (for example <code class="text-xs font-mono text-slate-800 dark:text-slate-200">/ui</code> on port 3000). The
      gateway process listens on
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">PORT + 1</code>. Vite proxies
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">/admin</code>,
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">/mcp</code>,
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">/health</code>, and related API paths to that
      backend, so the browser uses a single origin.
    </p>
  </section>

  <section
    class="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3 text-sm text-slate-600 dark:text-slate-400"
  >
    <h2 class="text-sm font-semibold text-slate-800 dark:text-slate-200">npm run dev</h2>
    <p>
      Only the gateway runs. It serves HTTP on
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">HOST</code> /
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">PORT</code> from
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">.env</code>, including the built UI under
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">/ui</code> when those static files exist.
    </p>
  </section>

  <section
    class="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3 text-sm text-slate-600 dark:text-slate-400"
  >
    <h2 class="text-sm font-semibold text-slate-800 dark:text-slate-200">npm --prefix ui run dev</h2>
    <p>
      SvelteKit dev server defaults to port
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">5173</code> and proxies API routes to the
      gateway address taken from the repo root
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">.env</code>
      (<code class="text-xs font-mono text-slate-800 dark:text-slate-200">HOST</code> /
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">PORT</code>). Use this when working on the UI
      while the gateway is already running on that port.
    </p>
  </section>

  <p class="text-xs text-slate-400 dark:text-slate-600">
    Authoritative detail: repository <code class="font-mono">docs/development.md</code>.
  </p>
</div>
