# Changelog

All notable changes to MCPR Gateway are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

---

## [Unreleased]

### Added

- 2026-03-28 - Added - Inbound OAuth for MCP clients: `auth.mode` `static_key` | `oauth` | `hybrid`, RFC 9728 `/.well-known/oauth-protected-resource` metadata, `401` + `WWW-Authenticate` challenges, JWT validation via `jose` + JWKS discovery, optional browser Origin allowlist/CORS helper fields on inbound OAuth config, extra MCP `Content-Type` parsing and `415` on unsupported media types; WebUI config section; docs and Vitest coverage (unit + integration).

### Fixed

- 2026-03-29 - Fixed - Inbound OAuth browser origin checks now require exact origin matches, protected-resource metadata routes emit CORS headers for allowed browser origins, and `PUT /admin/config/policies` no longer overwrites newer bearer tokens from dedicated auth endpoints
- 2026-03-28 - Fixed - stdio downstream transport now converts `stdin` `EPIPE` / closed-pipe writes into rejected MCP transport errors instead of leaking unhandled exceptions during tests and benchmark flows
- 2026-03-28 - Fixed - `npm test`, `npm run test:coverage`, and `npm run test:watch` now run the native runtime preflight, auto-rebuild stale `isolated-vm` / `better-sqlite3` binaries, and force `--no-node-snapshot` before starting Vitest
- 2026-03-28 - Fixed - The standard repository contract is now `npm ci`, `npm run build`, `npm start`; `npm run build` validates Node 24 and rebuilds stale native modules before producing the UI and gateway artifacts
- 2026-03-28 - Fixed - `npm start` now works in remote/self-hosted environments without a repo-local `.env` file as long as required variables are injected by the platform, while still rejecting missing or placeholder security values
- 2026-03-28 - Fixed - `npm start`, `npm run dev`, and `npm run dev:gateway` now auto-rebuild `isolated-vm` and `better-sqlite3` once when they detect stale binaries from another Node ABI, instead of crashing immediately
- 2026-03-28 - Fixed - The repository default install flow now targets a built end-user runtime: `npm run setup` prepares dependencies and production artifacts, `npm start` loads `.env` and serves the built UI plus gateway on one port, and startup now refuses missing or placeholder security values from `.env.example`
- 2026-03-28 - Fixed - Root `npm ci` now installs `ui/` dependencies via a guarded `postinstall` that skips when `ui/package.json` is absent, preserving Docker/staged installs while keeping fresh-clone setup automatic; setup still warns when either dependency tree is missing
- 2026-03-27 - Fixed - `npm run docker:up` and docs now use `docker compose --project-directory .` so repo-root `.env` is loaded for `${ADMIN_TOKEN:?}` / port interpolation (compose file under `docker/` otherwise skips root `.env`); README notes container `HOST=0.0.0.0` vs dev `.env` and `127.0.0.1` vs `localhost` for browsers
- 2026-03-27 - Fixed - Docker Compose now loads the repo-root `.env`, sets production-safe runtime defaults, exposes the bundled UI and MCP on port 3000, and adds a healthcheck for publish-ready installs
- 2026-03-27 - Fixed - Benchmark and integration tests now read `gateway_search_tools` matches from MCP `structuredContent`, matching the current `tools/call` contract
- 2026-03-27 - Fixed - Sandbox timeout tests now assert the current fail-closed timeout error instead of expecting partial runtime results
- 2026-03-27 - Docs - Development guide now tells contributors to rebuild `isolated-vm` and `better-sqlite3` after switching Node versions
- 2026-03-27 - Fixed - Docker image now installs Alpine native build prerequisites so production builds can compile `better-sqlite3` and other native modules when no prebuilt binary is available
- `/admin/namespaces` metrics now estimate MCP `tools/list` token count after initialize, correctly distinguishing between default mode (full catalog) and compat/code modes (two meta-tools)
- 2026-03-27 - Fixed - Benchmark executor now skips compat-only `gateway_search_tools` flows for namespaces configured in default/code mode instead of aborting mixed-mode real benchmark runs
- 2026-03-27 - Fixed - Benchmark real-run output now deduplicates requested modes and reports metrics scoped per namespace instead of repeating global aggregates

### Added

- `initializeInstructionsTokens` and `firstTurnEstimatedTokens` fields in `/admin/namespaces` metrics response
- `catalogMetrics` in metrics response: per-downstream catalog token totals and per-tool overrides
- Exported `buildGatewayInstructions` for use outside the MCP initialize handler, enabling parity between runtime and admin estimates
- 2026-03-27 - Added - Canonical benchmark CLI via `npm run benchmark -- <smoke|real|prepare>` with repo-root `.env` loading, namespace filters, mode comparison, and preflight checks for Node/native SQLite readiness

### Changed

- 2026-03-27 - Changed - Startup now fails fast when `ADMIN_TOKEN` is set without `GATEWAY_ADMIN_PASSWORD`, and when `DOWNSTREAM_AUTH_ENCRYPTION_KEY` is present but not a valid base64 32-byte key
- 2026-03-27 - Changed - Docker and security docs now distinguish dev `PORT + 1` behavior from the single-port Docker runtime and require explicit admin credentials for production
- 2026-03-27 - Changed - Benchmark dataset preparation now accepts namespace, server, and tool filters so real benchmarks can target user-defined catalogs instead of hardcoded names only

---

## [0.1.0] — 2026-03-26

### Changed

- Project renamed from **MCP Session Gateway** to **MCPR Gateway**
- npm package and CLI binary updated to `mcpr-gateway`
- Client token environment variable standardized to `MCPR_GATEWAY_TOKEN`
- Codex TOML server key standardized to `[mcp_servers.mcpr-gateway]`
- Documentation restructured: files moved to `docs/`, filenames converted to CAPSLOCK format

### Added

- **Three operating modes** per namespace: Code, Compat, Default
- **HTTP-Streamable transport** — `GET /mcp/:namespace` (SSE) + `POST /mcp/:namespace` (JSON-RPC)
- **Session management** — SQLite-backed (default) or in-memory; configurable TTL (default 30 min)
- **BM25 lexical tool ranking** for compat mode (`gateway_search_tools` / `gateway_call_tool`)
- **`isolated-vm` sandbox** for code mode (`gateway_run_code` / `gateway_help`) with built-in MCP runtime API (`catalog`, `mcp`, `result`, `artifacts`)
- **Two-tier config model** — `bootstrap.json` seeds SQLite once; admin panel manages runtime config with version history
- **`static_key` auth** — Bearer tokens managed via Admin UI (Access Control panel) or `auth.staticKeys` in bootstrap
- **Admin API** — protected by `ADMIN_TOKEN` + `GATEWAY_ADMIN_USER` / `GATEWAY_ADMIN_PASSWORD`; registers when `ADMIN_TOKEN` is set or `NODE_ENV !== production`
- **OAuth downstream auth** — bearer token forwarding with provider allowlist
- **WebUI** — SvelteKit 2 + TailwindCSS v4, served at `/ui/`; panels: Servers, Sessions, Access Control, Audit, Config, Namespaces, Tools
- **Structured logging** via Pino; optional SQLite audit trail with prune endpoint
- **Resilience features** — rate limiting (`@fastify/rate-limit`), per-downstream concurrency limits, health-aware selector ranking, configurable timeouts
- **Selector publication** — optional conservative description/schema compression for downstream tool metadata
- **Namespace isolation** — servers and tools scoped per namespace; roles control access per bearer token
- **Multi-stage Docker build** (`docker/Dockerfile`); Compose config in `docker/docker-compose.yml`
- **Benchmark suite** (`bench/`) with smoke and full run modes
- **Config version history** — SQLite stores all admin config snapshots with rollback support

### Runtime

- **Node.js 24 LTS** required (`engines: "24.x"`)
- Docker runtime pinned to `node:24-alpine`
- `--no-node-snapshot` required for `isolated-vm`; set automatically by dev scripts and Docker entrypoint

### Known caveats

- MCP/JSON-RPC tool failures return HTTP 200 with `error` object in body — always inspect the JSON-RPC payload, not the HTTP status
- Some MCP clients do not expose the JSON-RPC `result` payload to the model after a successful call
- stdio transport for gateway **clients** not yet supported (downstream stdio connections are supported)
- PostgreSQL not yet supported; SQLite and in-memory only
- 2026-03-27 - Fixed - Docker run documentation now uses the explicit `--env-file .env -f docker/docker-compose.yml` flow instead of the broken `--project-directory .` example, and MCP client examples now point at the built-in `default` namespace used when no bootstrap config exists
- 2026-03-27 - Fixed - WebUI static responses now override the default CSP to allow the SvelteKit inline bootstrap script and wrapper style only under `/ui/`, fixing blank pages in Docker/production while keeping the stricter global policy for API routes
