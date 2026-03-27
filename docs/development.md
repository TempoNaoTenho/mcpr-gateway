# Development

## Scripts

| Script                       | Command                         | Purpose                             |
| ---------------------------- | ------------------------------- | ----------------------------------- |
| `dev`                        | `node scripts/dev-all.mjs`      | Full-stack: Vite on `PORT`, gateway on `PORT+1` |
| `dev:gateway`                | `node scripts/dev-gateway.mjs`  | Hot-reload gateway only             |
| `build`                      | `build:ui` then `build:gateway` | UI + production bundle to `dist/`   |
| `build:gateway`              | `tsup`                          | Gateway bundle to `dist/` only      |
| `typecheck`                  | `tsc --noEmit`                  | Type-check                          |
| `check:gate`                 | typecheck + lint                | Fast gate before tests              |
| `test`                       | `check:gate` then `vitest run` | Tests (`pretest` runs first)       |
| `test:coverage`              | `check:gate` + Vitest coverage  | Same as CI test step               |
| `test:watch`                 | `vitest`                        | Watch (no pretest; run `check:gate` yourself if needed) |
| `verify`                     | `npm ci`, coverage, UI check, `build` | Full local / pre-push suite |
| `ci`                         | same as `verify`                | Common name for pipelines / hooks |
| `prepush`                    | same as `verify`                | Hook-friendly name                 |
| `lint`                       | `eslint src`                    | Lint                                |
| `format`                     | `prettier --write .`            | Format                              |
| `setup`                      | `tsx scripts/setup.ts`          | Checks, `.env` help, optional bootstrap (advanced) |
| `build:ui`                   | npm in `ui/`                    | Production UI build                 |
| `build:all`                  | same as `build`                 | Alias                               |
| `dev:all`                    | same as `dev`                   | Alias                               |
| `docker:build` / `docker:up` | Docker                          | See [Deployment](deployment.md)     |

Defined in [`package.json`](../package.json).

## Web UI

The admin UI lives under [`ui/`](../ui/) (Svelte).

- **Development:** `npm run dev` (full stack) or `npm run dev:gateway` with `npm --prefix ui run dev` if you prefer separate terminals.
- **Production assets:** `npm run build` runs `build:ui` then `build:gateway`; `npm run build:ui` alone produces `ui/build` (Dockerfile builds UI in its own stage; runtime uses `ui/dist` layout in the image).

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
