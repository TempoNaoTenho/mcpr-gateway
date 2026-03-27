# MCPR Gateway

<p align="center">
  <img src="https://img.shields.io/badge/node-22%20%7C%2024%20LTS-brightgreen" alt="Node.js" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License" />
  <img src="https://img.shields.io/badge/MCP-2025--03--26-purple" alt="MCP Protocol" />
</p>

**A self-hosted MCP gateway that gives you full control over which tools your AI client sees — and how it interacts with them. Primarly focused on sandboxed code execution so LLM can auto-discover downstreams servers and tools, also supports a compat mode (two tools) and default mode (all tools).**

> Some say MCP is dead, hopefully we can give it **CPR**.. 🥁

## Inspired by

- [Anthropic's Code Execution](https://www.anthropic.com/engineering/code-execution-with-mcp?_hsmi=390282592)
- [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode-mcp/)

## Current features

| Feature                                              | ✅/❌/Optional   | Feature                                         | ✅/❌/Optional |
| ---------------------------------------------------- | ---------------- | ----------------------------------------------- | -------------- |
| WebUI and Admin API                                  | ✅               | OAuth Support                                   | ✅             |
| Active sessions management                           | ✅               | Audit & Observability                           | ✅             |
| Auto refresh tools                                   | ✅               | Namespaces for MCP Downstream Servers Isolation | ✅             |
| SQLite Support                                       | ✅               | Active sessions management                      | ✅             |
| Downstream tool editing                              | ✅               | MCP Client Permission Management                | ✅             |
| Downstream tool token usage counter                  | ✅               | Client Bearer Token Managment                   | ✅             |
| HTTP-Streamable Support                              | ✅ - All         | Bootstrap file support                          | ✅             |
| BM25 / lexical ranking                               | ✅ - Compat Mode |
| Two-tool Low Schema Mode                             | ✅ - Compat Mode |
| Performance-focused Sandbox Execution Tool discovery | ✅ - Code Mode   |
| All Tools Loaded Mode                                | ✅ - Default     |
| Stdio Support                                        | ❌               |
| PGSQL Support                                        | ❌               |

## Operating Modes

| Mode        | Tool Window                                                | Best For                                              |
| ----------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| **Code**    | 2 tools: `gateway_run_code` + `gateway_help`               | Programmatic multi-tool orchestration in a JS sandbox |
| **Compat**  | 2 meta-tools: `gateway_search_tools` + `gateway_call_tool` | Large tool sets, minimal context usage                |
| **Default** | All enabled downstream tools, filtered by namespace        | Full transparency, small tool sets                    |

Modes are configured per namespace and can be mixed across different access paths. For instance, you can create a `mcp/dev` with complex tools to be used in code mode or `/mcp/personal` with a small set of tools to be used in default mode for example.

## Demo

<p align="center">
  <img src="docs/assets/demo.gif" alt="WebUI Dashboard"/>
</p>

---

## 🏗️ Architecture

```mermaid
flowchart LR
    subgraph clients["MCP Clients"]
        claude["Claude / Claude Code"]
        codex["OpenAI Codex"]
        inspector["MCP Inspector"]
    end

    subgraph gateway["MCPR Gateway  (Fastify + TypeScript)"]
        direction TB
        auth["🔐 Auth & RBAC\nBearer token → role → namespace"]
        modes["⚙️ Operating Modes\nCode · Compat · Default"]
        registry["📡 Server Registry\n& Health Monitor"]
        sessions["💾 Session Store"]
    end

    subgraph downstream["Downstream MCP Servers"]
        s1["Server A\n(stdio)"]
        s2["Server B\n(HTTP)"]
        s3["Server C\n(SSE)"]
    end

    adminui["🖥️ Admin WebUI\n/ui/"]
    subgraph webui["Admin Panels"]
        direction TB
        wp1["📊 Dashboard · 🔌 Servers · 🛠️ Tools"]
        wp2["💬 Sessions · 🔑 Access Control"]
        wp3["📋 Audit · ⚙️ Config & History · 🌐 Namespaces"]
    end
    sqlite[("🗄️ SQLite\nSessions · Audit · Config")]

    clients -->|"Bearer token\nPOST /mcp/:namespace"| auth
    auth --> modes
    modes --> registry
    registry --> s1 & s2 & s3
    sessions <--> sqlite
    gateway --- sessions
    adminui -->|"admin_session cookie\n/admin/*"| gateway
    adminui --- webui
```

---

## ⚡ Quick Setup

### 1. Start the gateway

```bash
# Clone and set up interactively (.env + bootstrap.json)
git clone <repo-url> mcpr-gateway && cd mcpr-gateway
npm run setup
npm run dev        # UI on PORT, gateway on PORT+1
```

```bash
# Or with Docker Compose
docker compose -f docker/docker-compose.yml up
```

### 2. Connect an MCP client

Issue a **client Bearer token** from the Access Control panel at `/ui/access` (or add it to `auth.staticKeys` in `bootstrap.json`), then configure your client:

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "mcpr-gateway": {
      "type": "http",
      "url": "http://localhost:3001/mcp/default",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

**OpenAI Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.mcpr-gateway]
type = "http"
url  = "http://localhost:3001/mcp/default"
bearer_token_env_var = "MCPR_GATEWAY_TOKEN"
```

```bash
export MCPR_GATEWAY_TOKEN=<your-token>
```

**Any HTTP MCP client**: send `Authorization: Bearer <token>` on every request. After `initialize`, include the `Mcp-Session-Id` header returned by the gateway.

> 💡 Replace `default` in the URL with the namespace configured in `bootstrap.json`. Multiple namespaces can map to different modes and downstream server pools.

---

## 🔍 Feature Details

### 🔐 Security

| Concern                | Implementation                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Client auth            | Bearer token per user/service, issued via Admin UI or `auth.staticKeys` in bootstrap                                                                                           |
| Admin protection       | `ADMIN_TOKEN` enables login; `GATEWAY_ADMIN_USER` / `GATEWAY_ADMIN_PASSWORD` are the credentials; in `NODE_ENV=production` with no `ADMIN_TOKEN`, admin routes are not mounted |
| Downstream credentials | AES-encrypted in SQLite when `DOWNSTREAM_AUTH_ENCRYPTION_KEY` is set (default in `npm run setup`)                                                                              |
| HTTP security headers  | `@fastify/helmet` applied to all responses                                                                                                                                     |
| CORS                   | Restricted to loopback origins (`localhost`, `127.0.0.1`, `::1`) for MCP endpoints                                                                                             |

### 🌐 Sessions & Transport

| Topic          | Detail                                                                           |
| -------------- | -------------------------------------------------------------------------------- |
| Persistence    | SQLite (default) or in-memory (`SESSION_BACKEND=memory`)                         |
| TTL            | 30 min default (`session.ttlSeconds = 1800`), automatic cleanup                  |
| Transport      | HTTP-Streamable: `GET /mcp/:namespace` (SSE) + `POST /mcp/:namespace` (JSON-RPC) |
| Session header | `Mcp-Session-Id` required on all requests after `initialize`                     |
| Admin ops      | Query, inspect, and revoke sessions via `/ui/sessions` or `GET /admin/sessions`  |

### 🔌 Downstream Servers

| Topic             | Detail                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| Transports        | `stdio` and `http` / streamable-HTTP                                    |
| Auth options      | `none`, `bearer` (env var or inline), `oauth`                           |
| Credentials       | Encrypted at rest; UI-managed via `/ui/servers`                         |
| Health monitoring | Continuous checks; degraded servers penalized in tool selection ranking |
| Namespacing       | Servers assigned per namespace; tool pool isolated per access path      |

### 🛡️ Role-Based Access Control

| Concept   | Description                                                                  |
| --------- | ---------------------------------------------------------------------------- |
| Namespace | Isolated access path — e.g. `/mcp/dev`, `/mcp/prod`, `/mcp/personal`         |
| Role      | Maps a bearer token to one or more namespaces with allowed operating modes   |
| Token     | Per-client Bearer token, issued via Admin UI and stored in SQLite            |
| Auth mode | `static_key` — token resolved to role; role checked against namespace policy |

### 🖥️ Admin WebUI

Served at `/ui/` — **SvelteKit 2 + TailwindCSS v4**. Requires admin login when `ADMIN_TOKEN` is set.

| Panel          | Path             | What you can do                                                    |
| -------------- | ---------------- | ------------------------------------------------------------------ |
| Dashboard      | `/ui/`           | Session counts, server health overview                             |
| Servers        | `/ui/servers`    | Add, edit, delete downstream servers; view health status           |
| Sessions       | `/ui/sessions`   | Inspect active sessions; revoke individual sessions                |
| Access Control | `/ui/access`     | Issue and revoke client bearer tokens                              |
| Audit          | `/ui/audit`      | Browse events filtered by user, tool, event type, date range       |
| Config         | `/ui/config`     | Edit runtime config; view full version history; one-click rollback |
| Namespaces     | `/ui/namespaces` | Token estimates, catalog sizes, mode metrics per namespace         |
| Tools          | `/ui/tools`      | Browse full downstream tool catalog                                |

### 📊 Audit & Observability

| Topic        | Detail                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Logging      | Pino structured logs to stdout; level set via `LOG_LEVEL` env var                              |
| Audit trail  | SQLite-persisted per-event records; prunable by retention window (`AUDIT_RETENTION_DAYS`)      |
| Audit events | `SessionCreated`, `ToolExecuted`, `ExecutionDenied`, `DownstreamMarkedUnhealthy`               |
| Query API    | `GET /admin/audit` — filters: `session_id`, `user_id`, `event_type`, `tool_name`, `from`, `to` |

### ⚡ Resilience

| Feature                | Config key                 | Default                                       |
| ---------------------- | -------------------------- | --------------------------------------------- |
| Rate limiting          | `resilience.rateLimit.*`   | Per-session and per-user windows              |
| Downstream concurrency | `resilience.concurrency.*` | Per-server cap                                |
| Response timeout       | `resilience.timeoutMs`     | Configurable                                  |
| Health-aware ranking   | Automatic                  | Unhealthy servers penalized in tool selection |

---

### 🔍 Benchmarking

- Current benchmark suite is a work in progress and is not yet ready for production use. Ideally we should compare token usage for discovery tools and complete tool execution cases.

### To-do

- [ ] Create a realistic benchmark suite to compare different modes and downstream servers
- [ ] Implement Gateway stdio transport
- [ ] Implement PostgreSQL support

## 📚 Documentation

| Guide                                      | Audience               | Contents                                                                     |
| ------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------- |
| [Getting Started](docs/GETTING-STARTED.md) | Operators, integrators | Dependencies, setup, MCP client flow, auth basics                            |
| [Configuration](docs/CONFIGURATION.md)     | Operators              | `bootstrap.json`, selector publication, `CONFIG_PATH`, two-tier config model |
| [Architecture](docs/ARCHITECTURE.md)       | Contributors           | Sessions, registry, selector, triggers, high-level flow                      |
| [HTTP API](docs/reference/HTTP-API.md)     | Integrators            | Health, MCP JSON-RPC, admin, debug, static UI — full endpoint reference      |
| [Deployment](docs/DEPLOYMENT.md)           | Operators              | Docker Compose, persistence, production hardening, TLS                       |
| [Development](docs/DEVELOPMENT.md)         | Contributors           | npm scripts, project layout, tests, Web UI workflow                          |
| [Changelog](docs/CHANGELOG.md)             | Operators, adopters    | Release notes, runtime requirements, known caveats                           |

> Config schema source of truth: [`src/config/schemas.ts`](src/config/schemas.ts). For bootstrap examples and copy-paste snippets, see [`config/README.md`](config/README.md).

---

## 📄 License

MIT — see [package.json](package.json).
