# Development

Contributor guide for the MCPR Gateway project. Covers setup, scripts, project layout, test strategy, UI workflow, and documentation conventions.

## Prerequisites

- **Node.js 22 or 24 LTS** (`engines: ">=22 <25"` in `package.json`)
  - ⚠️ Avoid Node 25 and other odd-numbered releases — `isolated-vm` (code mode) is incompatible
- **npm 10+** (bundled with Node 22/24)
- For Docker work: Docker Engine and Compose v2

## Scripts

| Script | Command | Purpose |
| ------ | ------- | ------- |
| `dev` | `npm run dev` | Full-stack dev: Vite UI on `PORT`, gateway on `PORT+1` (recommended) |
| `dev:gateway` | `npm run dev:gateway` | Gateway API only on `PORT`; run UI with `npm --prefix ui run dev` separately |
| `build` | `npm run build` | Build both UI and gateway for production |
| `build:gateway` | `npm run build:gateway` | TypeScript → `dist/` via tsup |
| `build:ui` | `npm run build:ui` | SvelteKit UI → `ui/build/` |
| `setup` | `npm run setup` | Interactive setup: creates `.env`, checks Node/ports, optionally creates `bootstrap.json` |
| `typecheck` | `npm run typecheck` | `tsc --noEmit` — no output files, types only |
| `lint` | `npm run lint` | ESLint over `src/` |
| `format` | `npm run format` | Prettier over entire repo |
| `test` | `npm test` | Typecheck + lint, then Vitest run (no coverage) |
| `test:coverage` | `npm run test:coverage` | Typecheck + lint, then Vitest with v8 coverage |
| `test:watch` | `npm run test:watch` | Vitest watch mode — skips pretest hook |
| `verify` | `npm run verify` | Full pre-push suite: `npm ci`, coverage, UI check, production build |
| `benchmark` | `npm run benchmark -- <command>` | Canonical benchmark CLI (`smoke`, `real`, `prepare`) |
| `benchmark:smoke` | `npm run benchmark:smoke` | Quick smoke benchmark (single pass) |
| `benchmark:real` | `npm run benchmark:real -- --namespaces ns1,ns2` | Benchmark the active DB/config using selected namespaces |
| `benchmark:all` | `npm run benchmark:all` | Full benchmark suite |
| `docker:build` | `npm run docker:build` | Build multi-stage Docker image |
| `docker:up` | `npm run docker:up` | Build and start via Docker Compose |

> `pretest` runs `typecheck + lint` automatically before `npm test` and `npm run test:coverage`. Use `test:watch` to skip it during rapid iteration.

### Benchmark CLI

Use the canonical CLI instead of calling files under `bench/` directly:

```bash
# Show commands and flags
npm run benchmark -- --help

# Quick fixture smoke pass
npm run benchmark -- smoke

# Real benchmark against the active SQLite/runtime config
npm run benchmark -- real --namespaces research,prod

# Prepare dataset + diagnostics only
npm run benchmark -- prepare --namespaces research --output-dir ./bench/datasets/local

# Prepare and execute immediately with explicit mode comparison
npm run benchmark -- prepare --namespaces research --compare-modes default,compat,code --run
```

Behavior:

- The CLI auto-loads repo-root `.env` before resolving `CONFIG_PATH` and `DATABASE_PATH`.
- `real` requires `--namespaces`; `prepare` can default to all configured namespaces.
- `--compare-modes` controls which mode summaries are printed. `compat` is only runnable when the namespace is currently configured in compat mode; otherwise it is reported as skipped.
- `default` summary maps to the benchmark baseline exposure, and `code` maps to the code-mode simulation already used by the benchmark suite.
- The command fails early on unsupported Node versions or incompatible `better-sqlite3` builds.

## Project layout

### Source (`src/`)

| Directory | Responsibility |
| --------- | -------------- |
| `src/admin/` | Admin API route handlers (servers, sessions, config, audit, access control) |
| `src/auth/` | Auth service — `static_key` bearer token resolution (`service.ts`) |
| `src/candidate/` | Candidate pool filtering — takes toolcards, applies namespace + enabled filters |
| `src/config/` | Config loader, `RuntimeConfigManager`, Zod schemas (`schemas.ts`) |
| `src/db/` | `IDbAdapter` interface, `SqliteAdapter`, Drizzle ORM schema and migrations |
| `src/gateway/` | Fastify server setup and route registration |
| `src/gateway/dispatch/` | MCP method handlers: `initialize.ts`, `tools-list.ts`, `tools-call.ts` |
| `src/gateway/publish/` | Tool projection: `project.ts` (public view), `compress.ts` (description/schema compression) |
| `src/gateway/routes/` | HTTP route registrations: `mcp.ts`, `admin.ts`, `debug.ts`, `ui.ts`, `health.ts` |
| `src/health/` | Registry health check endpoints |
| `src/observability/` | Pino structured logger, SQLite audit writer |
| `src/policy/` | Policy resolution — namespace + mode authorization per principal |
| `src/registry/` | Downstream server registry, MCP client connections, health monitor |
| `src/repositories/` | SQLite repository layer: sessions, audit, config versions, access tokens, downstream auth |
| `src/resilience/` | Rate limiter (`rateLimiter.ts`) — wraps `@fastify/rate-limit` |
| `src/router/` | Tool call routing to the correct downstream server (`router.ts`) |
| `src/runtime/` | Code mode sandbox: `sandbox.ts`, `catalog-api.ts`, `mcp-api.ts`, `result-api.ts`, `artifact-store.ts` |
| `src/selector/` | BM25 engine (`bm25.ts`), scorer (`scorer.ts`), trigger-aware window refresh |
| `src/session/` | Session store interface + SQLite and in-memory implementations |
| `src/toolcard/` | Toolcard normalization (`toolcard.ts`) and sanitizer (`sanitizer.ts`) |
| `src/trigger/` | Trigger engine — decides when to refresh the tool window after a `tools/call` |
| `src/types/` | Shared TypeScript types (server, session, toolcard, policy, etc.) |
| `src/utils/` | Shared utility functions |

### Other directories

| Directory | Contents |
| --------- | -------- |
| `bench/` | Benchmark suite (`main.ts`, scenario files) |
| `config/` | Bootstrap config files (gitignored `bootstrap.json`, versioned `*.example.json`) |
| `data/` | SQLite database files (gitignored) |
| `docker/` | `Dockerfile` (multi-stage), `docker-compose.yml` |
| `scripts/` | Dev helpers: `setup.ts`, `dev-all.mjs`, `dev-gateway.mjs` |
| `test/` | Vitest test files (mirrors `src/` structure) |
| `ui/` | SvelteKit 2 + TailwindCSS v4 admin UI |

## Entry point

`src/index.ts` bootstraps the server:

1. Selects persistence backend (`SqliteAdapter` or in-memory based on `SESSION_BACKEND`)
2. Loads config via `RuntimeConfigManager.initialize()`
3. Registers all route groups (health, MCP, admin, debug, UI static)
4. Starts the downstream registry and health monitor
5. Binds Fastify to `HOST:PORT`

## Web UI

- **Stack:** SvelteKit 2, TailwindCSS v4
- **Served at:** `/ui/` when built files exist under `ui/dist`, `ui/build`, or `UI_STATIC_DIR`
- **Root redirect:** `/` → `/ui/` when a UI build is detected

### Routes

| Path | Panel |
| ---- | ----- |
| `/ui/` | Dashboard — session counts, server health overview |
| `/ui/servers` | Downstream server management |
| `/ui/sessions` | Active session list and detail |
| `/ui/access` | Bearer token management (Access Control) |
| `/ui/audit` | Audit log viewer |
| `/ui/config` | Config editor + version history |
| `/ui/namespaces` | Namespace metrics (token estimates, catalog sizes) |
| `/ui/tools` | Tool catalog browser |

### Dev workflow

```bash
# Full stack (recommended) — UI at PORT, gateway at PORT+1
npm run dev

# UI dev only (hot reload) — run alongside npm run dev:gateway
npm --prefix ui run dev

# Production build
npm run build:ui   # output: ui/build/
```

## Tests

- **Framework:** Vitest 3 with v8 coverage provider
- **Pretest hook:** `typecheck + lint` run automatically before `npm test` and `npm run test:coverage`
- **Watch mode:** `npm run test:watch` skips the pretest hook for fast iteration
- **Coverage:** `npm run test:coverage` generates HTML + JSON reports under `coverage/`
- **Full verify:** `npm run verify` — `npm ci`, full coverage pass, UI type-check, production build

Test files mirror the `src/` structure under `test/` (e.g. `test/unit/admin-routes.test.ts`).

## Code mode sandbox

The `isolated-vm` sandbox lives in `src/runtime/`:

| File | Purpose |
| ---- | ------- |
| `sandbox.ts` | `isolated-vm` isolate lifecycle — creation, script compilation, timeout enforcement |
| `catalog-api.ts` | `catalog.search()` and `catalog.describe()` — tool discovery API |
| `mcp-api.ts` | `mcp.call()` and `mcp.batch()` — downstream tool execution |
| `result-api.ts` | `result.text()`, `result.items()`, `result.limit()`, `result.pick()`, `result.count()` |
| `artifact-store.ts` | `artifacts.save()` and `artifacts.list()` — session-scoped artifact storage |

⚠️ Do not add Node.js APIs to the sandbox context without reviewing `isolated-vm`'s security boundary. The sandbox has no filesystem or network access by design.

## Documentation conventions

- **Filenames:** CAPSLOCK with hyphens (e.g. `GETTING-STARTED.md`, not `getting-started.md`)
- **Links:** relative paths from the doc's own location
- **No placeholders:** use real file paths, real API names, real env var names
- **Cross-reference rule:** after any rename or new file, update all inbound links — check `ARCHITECTURE.md`, `CONFIGURATION.md`, `GETTING-STARTED.md`, and the root `README.md` guides table
- **Authoritative schema source:** `src/config/schemas.ts` (`GatewayConfigFileSchema`) — docs describe behavior, not exhaustive schema dumps; link to the file rather than duplicating field lists

## See Also

- [Architecture](ARCHITECTURE.md) — system components, request flow, session lifecycle
- [Configuration](CONFIGURATION.md) — bootstrap.json format, two-tier config model
- [HTTP API](reference/HTTP-API.md) — all routes with request/response details
- [Deployment](DEPLOYMENT.md) — Docker, production setup, admin protection
