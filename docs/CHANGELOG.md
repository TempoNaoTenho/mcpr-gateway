# Changelog

All notable changes to MCPR Gateway are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

---

## [Unreleased]

### Fixed
- `/admin/namespaces` metrics now estimate MCP `tools/list` token count after initialize, correctly distinguishing between default mode (full catalog) and compat/code modes (two meta-tools)

### Added
- `initializeInstructionsTokens` and `firstTurnEstimatedTokens` fields in `/admin/namespaces` metrics response
- `catalogMetrics` in metrics response: per-downstream catalog token totals and per-tool overrides
- Exported `buildGatewayInstructions` for use outside the MCP initialize handler, enabling parity between runtime and admin estimates

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
- **Node.js 22 or 24 LTS** required (`engines: ">=22 <25"`)
- Node 25 and odd-numbered releases explicitly unsupported (isolated-vm incompatibility)
- Docker runtime pinned to `node:24-alpine`
- `--no-node-snapshot` required for `isolated-vm`; set automatically by dev scripts and Docker entrypoint

### Known caveats
- MCP/JSON-RPC tool failures return HTTP 200 with `error` object in body — always inspect the JSON-RPC payload, not the HTTP status
- Some MCP clients do not expose the JSON-RPC `result` payload to the model after a successful call
- stdio transport for gateway **clients** not yet supported (downstream stdio connections are supported)
- PostgreSQL not yet supported; SQLite and in-memory only
