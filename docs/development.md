# Development

## Scripts

| Script                       | Command                         | Purpose                             |
| ---------------------------- | ------------------------------- | ----------------------------------- |
| `dev`                        | `tsx watch src/index.ts`        | Hot-reload gateway                  |
| `build`                      | `tsup`                          | Production bundle to `dist/`        |
| `typecheck`                  | `tsc --noEmit`                  | Type-check                          |
| `test`                       | `vitest run`                    | Unit/integration tests              |
| `test:watch`                 | `vitest`                        | Watch mode                          |
| `lint`                       | `eslint src`                    | Lint                                |
| `format`                     | `prettier --write .`            | Format                              |
| `setup`                      | `tsx scripts/setup.ts`          | Interactive `config/bootstrap.json` |
| `build:ui`                   | npm in `ui/`                    | Production UI build                 |
| `build:all`                  | UI then gateway build           | Release artifact                    |
| `dev:all`                    | `concurrently` gateway + UI dev | Full stack local                    |
| `docker:build` / `docker:up` | Docker                          | See [Deployment](deployment.md)     |

Defined in [`package.json`](../package.json).

## Web UI

The admin UI lives under [`ui/`](../ui/) (Svelte).

- **Development:** `npm run dev:all` or `npm --prefix ui run dev` alongside `npm run dev`.
- **Production assets:** `npm run build:ui` produces `ui/build` (Dockerfile uses this path; the gateway also accepts `ui/dist` or `UI_STATIC_DIR`).

The gateway serves the SPA under **`/ui/`** and redirects `/` → `/ui/` when files exist ([`src/gateway/routes/ui.ts`](../src/gateway/routes/ui.ts)).

More detail: [`ui/README.md`](../ui/README.md).

## Entry point

[`src/index.ts`](../src/index.ts) selects persistence via `SESSION_BACKEND` (default SQLite through `SqliteAdapter`, or `memory` for in-process sessions + file-backed admin config), registers health and MCP routes, and when executed as the main module loads config, runs `RuntimeConfigManager.initialize()`, starts the registry, and listens on `HOST`/`PORT`.

## Tests

```bash
npm test
```

Coverage (if configured) via Vitest v8 provider in devDependencies.

## Project layout (source)

| Area                        | Path                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| Config load / runtime merge | [`src/config/`](../src/config/)                                        |
| HTTP server and routes      | [`src/gateway/`](../src/gateway/)                                      |
| MCP method handlers         | [`src/gateway/dispatch/`](../src/gateway/dispatch/)                    |
| Tool call routing           | [`src/router/`](../src/router/)                                        |
| Registry                    | [`src/registry/`](../src/registry/)                                    |
| Session                     | [`src/session/`](../src/session/)                                      |
| Selector / triggers         | [`src/selector/`](../src/selector/), [`src/trigger/`](../src/trigger/) |
| SQLite                      | [`src/db/`](../src/db/), [`src/repositories/`](../src/repositories/)   |

## Documentation changes

After editing docs, keep links relative and align any env or route claims with the files above. The doc index is [docs/README.md](README.md).
