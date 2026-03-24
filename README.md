# Codeunctor MCP Gateway - MCP Managment and Sandboxed

**A self-hosted MCP gateway that gives you full control over which tools your AI client sees — and how it interacts with them.**

![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow) ![MCP Protocol](https://img.shields.io/badge/MCP-2025--03--26-purple)

---

## Overview

Modern LLM workflows often involve dozens of MCP servers. Exposing every tool to the client at once inflates the context window, increases latency, and makes it harder for the model to pick the right tool. MCP Session Gateway sits between your AI client and your downstream MCP servers, acting as a smart proxy that curates what the model sees.

The gateway maintains **stateful sessions** per client. Each session carries a **tool window** — a curated subset of available tools, selected by a BM25-ranked selector engine and refreshed dynamically based on execution history. Three operating modes let you choose how aggressively to compress the tool window for your use case.

All of this is managed through a built-in **WebUI** and a full **Admin REST API**, with role-based access control, audit logging, and Docker-ready deployment.

---

## Features

### Operating Modes

| Mode        | Tool Window                                                | Best For                                              |
| ----------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| **Default** | All enabled downstream tools, filtered by namespace        | Full transparency, small tool sets                    |
| **Compat**  | 2 meta-tools: `gateway_search_tools` + `gateway_call_tool` | Large tool sets, minimal context usage                |
| **Code**    | 2 tools: `gateway_run_code` + `gateway_help`               | Programmatic multi-tool orchestration in a JS sandbox |

Modes are configured per namespace and can be mixed across different access paths.

### Session Management

- Persistent sessions backed by **SQLite** (default) or in-memory store
- Configurable TTL (default 5 min) with automatic cleanup
- Session-scoped tool window tracks recent execution outcomes
- Admin can query, inspect, and revoke sessions via API or WebUI

### Downstream MCP Servers

- Supports **stdio** and **HTTP/streamable-HTTP** transports
- Per-server authentication: `none`, `bearer` (env var or literal), `oauth`
- UI-managed credentials encrypted at rest (`DOWNSTREAM_AUTH_ENCRYPTION_KEY`)
- Health monitoring with automatic penalization of degraded servers

### Role-Based Access Control

- **Namespaces** define isolated access paths (e.g. `/mcp/dev`, `/mcp/prod`)
- **Roles** map to namespaces with configurable allowed modes (`read`/`write`/`admin`)
- **Bearer tokens** issued per user/service, mapped to roles in config
- Two auth modes: `mock_dev` for local dev, `static_key` for production

### WebUI Admin Panel

- Built with SvelteKit 2 + TailwindCSS v4, served at `/ui/`
- Manage downstream servers (add, edit, delete, health status)
- Issue and revoke client bearer tokens
- Inspect and revoke active sessions
- Browse audit logs with filters (user, event type, tool name, date range)
- Edit runtime config with version history and one-click rollback
- Manage namespaces, roles, and starter packs

### Audit & Observability

- Structured logging via **Pino** (stdout, configurable level)
- SQLite-persisted **audit trail**: every session created, tool called, access denied
- Queryable via `GET /admin/audit` with filters; prunable by retention days
- Events: `SessionCreated`, `ToolExecuted`, `ExecutionDenied`, `DownstreamMarkedUnhealthy`

### Resilience

- Per-session and per-user **rate limiting** (configurable windows)
- Per-downstream **concurrency limits**
- Configurable **response timeouts**
- Health-aware tool selector (unhealthy servers penalized in rankings)

---

## Operating Modes In Depth

### Default Mode

Exposes all enabled downstream tools directly. The selector engine still applies namespace filtering and role policies, but the full tool catalog is visible. Best when you have a small, curated set of tools and want full transparency.

### Compat Mode _(recommended default)_

Replaces the entire tool catalog with two meta-tools:

- **`gateway_search_tools`** — BM25 lexical search over all available tools. Returns name, description, and server ID.
- **`gateway_call_tool`** — Proxy call to any tool returned by search. Handles routing, auth, and error normalization.

The client's context window only ever sees these two tools, regardless of how many downstream servers are registered. The model discovers and calls tools on demand.

```
# Typical flow:
1. gateway_search_tools("list files in repository")
   → returns: [{ name: "fs_list_dir", serverId: "filesystem" }, ...]

2. gateway_call_tool({ name: "fs_list_dir", serverId: "filesystem", arguments: { path: "/" } })
   → returns tool result
```

### Code Mode

Exposes a JavaScript sandbox (`isolated-vm`) with a built-in MCP runtime API:

```javascript
// Discover tools
const tools = await catalog.search('git operations', { limit: 5 })

// Call tools and process results
const files = await mcp.call('fs_list_dir', { path: '/src' })
const filtered = result.grep(files, '\.ts$')

// Batch calls
const [a, b] = await mcp.batch([
  ['tool_a', { arg: 1 }],
  ['tool_b', { arg: 2 }],
])

// Store large results for later
const ref = await artifacts.store(filtered)
return { ref, count: result.count(filtered) }
```

The sandbox is memory- and time-limited (configurable). The model writes a script; the gateway executes it against real downstream tools and returns the result. Useful for aggregation, filtering, and multi-step pipelines that would otherwise require many round-trips.

---

## Quick Start

**Prerequisites:** Node.js ≥ 20

```bash
git clone <repository-url>
cd mcp-session-gateway
npm ci
npm run setup    # interactive: writes config/bootstrap.json
npm run dev      # starts at http://127.0.0.1:3000
```

The MCP endpoint is `POST /mcp/<namespace>` (default namespace: `default`).

To run the full stack with the admin UI:

```bash
npm run build:ui   # build SvelteKit UI
npm run dev        # UI available at http://127.0.0.1:3000/ui/
```

**Docker** (after `npm run setup`):

```bash
npm run docker:up  # http://localhost:3000
```

See [docs/getting-started.md](docs/getting-started.md) for a complete walkthrough including client configuration examples.

---

## Configuration

Configuration uses a **two-tier model**:

| Tier          | Source                  | Role                                                                      |
| ------------- | ----------------------- | ------------------------------------------------------------------------- |
| **Bootstrap** | `config/bootstrap.json` | Seeds initial config on first start; `auth` section always read from file |
| **Runtime**   | `gateway.db` (SQLite)   | Authoritative after first start; managed via Admin UI or API              |

Changes made via the admin panel are written to SQLite and persist across restarts. Editing `bootstrap.json` after first start has no effect on servers/namespaces/roles (only `auth` is re-merged).

### Key Environment Variables

| Variable                         | Default             | Purpose                                             |
| -------------------------------- | ------------------- | --------------------------------------------------- |
| `HOST`                           | `127.0.0.1`         | Bind address (`0.0.0.0` for Docker)                 |
| `PORT`                           | `3000`              | HTTP port                                           |
| `CONFIG_PATH`                    | `./config`          | Directory containing `bootstrap.json`               |
| `DATABASE_PATH`                  | `./data/gateway.db` | SQLite file path                                    |
| `SESSION_BACKEND`                | _(unset = SQLite)_  | Set to `memory` for ephemeral sessions              |
| `ADMIN_TOKEN`                    | _(unset)_           | Protects `/admin/*` when set                        |
| `DOWNSTREAM_AUTH_ENCRYPTION_KEY` | _(unset)_           | Base64 32-byte key for encrypted downstream secrets |
| `LOG_LEVEL`                      | `info`              | Pino log level                                      |
| `AUDIT_RETENTION_DAYS`           | `90`                | Default audit log retention                         |

Secrets in `bootstrap.json` can be injected via environment interpolation:

```json
{
  "auth": {
    "mode": "static_key",
    "staticKeys": {
      "${GATEWAY_API_KEY}": { "userId": "my-client", "roles": ["user"] }
    }
  }
}
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full schema reference.

---

## Security

- **Local bind by default** — `HOST=127.0.0.1` prevents accidental network exposure
- **Two auth modes** — `mock_dev` (dev-only, no secrets required) and `static_key` (production, bearer tokens)
- **Admin API protection** — set `ADMIN_TOKEN`; in `NODE_ENV=production` with debug off and no token, admin routes are not mounted at all
- **Downstream credentials** — stored AES-encrypted in SQLite when `DOWNSTREAM_AUTH_ENCRYPTION_KEY` is set
- **Rate limiting** — per-session and per-user request limits via `@fastify/rate-limit`
- **Security headers** — `@fastify/helmet` applied to all responses
- **CORS** — restricted to loopback origins for MCP endpoints

See [docs/deployment.md](docs/deployment.md) for production hardening checklist.

---

## Documentation

| Doc                                                | Description                                                |
| -------------------------------------------------- | ---------------------------------------------------------- |
| [docs/getting-started.md](docs/getting-started.md) | Install, config, first run                                 |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md)     | `bootstrap.json` schema, env interpolation, SQLite vs file |
| [docs/architecture.md](docs/architecture.md)       | Concepts, request flow, selector engine                    |
| [docs/http-api.md](docs/http-api.md)               | HTTP routes reference                                      |
| [docs/deployment.md](docs/deployment.md)           | Docker, environment, security hardening                    |
| [docs/development.md](docs/development.md)         | Scripts, tests, UI development                             |
| [config/README.md](config/README.md)               | Config directory quick reference                           |

---

## License

MIT — see [package.json](package.json).
