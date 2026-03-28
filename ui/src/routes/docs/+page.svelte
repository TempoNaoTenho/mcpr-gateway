<svelte:head>
  <title>Docs — MCPR Gateway</title>
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
    <h2 class="text-sm font-semibold text-slate-800 dark:text-slate-200">npm start</h2>
    <p>
      This is the default end-user runtime from the repository root. Run
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">cp .env.example .env</code>,
      replace the
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">change-me-*</code>
      placeholders, then use
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">npm ci</code>,
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">npm run build</code>,
      and
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">npm start</code>.
      In hosted environments, you can inject the same variables directly from the platform and skip the
      local <code class="text-xs font-mono text-slate-800 dark:text-slate-200">.env</code> file.
      The gateway serves the built UI under
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">/ui/</code>
      and MCP on the same
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">HOST</code> /
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">PORT</code>.
    </p>
  </section>

  <section
    class="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3 text-sm text-slate-600 dark:text-slate-400"
  >
    <h2 class="text-sm font-semibold text-slate-800 dark:text-slate-200">Benchmark CLI</h2>
    <p>
      Use
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">npm run benchmark -- --help</code>
      to see the benchmark commands. The canonical flows are
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">smoke</code>,
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">real</code>,
      and
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">prepare</code>.
      The CLI auto-loads the repo root
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">.env</code>,
      resolves
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">CONFIG_PATH</code>
      and
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">DATABASE_PATH</code>,
      and can benchmark selected namespaces from the active SQLite config.
    </p>
    <p>
      Example:
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">npm run benchmark -- real --namespaces research,prod --compare-modes default,compat,code</code>
    </p>
  </section>

  <section
    class="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3 text-sm text-slate-600 dark:text-slate-400"
  >
    <h2 class="text-sm font-semibold text-slate-800 dark:text-slate-200">npm run dev</h2>
    <p>
      The admin UI is served by Vite at the root URL using the same
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">HOST</code>
      and
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">PORT</code> as in the project
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">.env</code>
      (for example <code class="text-xs font-mono text-slate-800 dark:text-slate-200">http://127.0.0.1:3000</code>). The
      gateway process listens on
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">PORT + 1</code>. Vite proxies
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">/admin</code>,
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">/mcp</code>,
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">/health</code>, and related API paths to that
      backend, so the browser uses a single origin.
      The static <code class="text-xs font-mono text-slate-800 dark:text-slate-200">/ui/</code> path is only used after
      <code class="text-xs font-mono text-slate-800 dark:text-slate-200">npm run build</code> or in Docker.
    </p>
  </section>

  <section
    class="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3 text-sm text-slate-600 dark:text-slate-400"
  >
    <h2 class="text-sm font-semibold text-slate-800 dark:text-slate-200">npm run dev:gateway</h2>
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
