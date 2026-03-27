# MCPR Gateway

<p align="center">
  <img src="https://img.shields.io/badge/node-22%20%7C%2024%20LTS-brightgreen" alt="Node.js" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License" />
  <img src="https://img.shields.io/badge/MCP-2025--03--26-purple" alt="MCP Protocol" />
</p>

**A self-hosted MCP gateway that gives you full control over which tools your AI client sees — and how it interacts with them. Primarly focused on sandboxed code execution so LLM can auto-discover downstreams servers and tools, also supports a compat mode (two tools) and default mode (all tools).**

> Some say MCP is dead, hopefully we can take good care of it.

## Inspired by

- [Anthropic's Code Execution](https://www.anthropic.com/engineering/code-execution-with-mcp?_hsmi=390282592)
- [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode-mcp/)

## Features

### WebUI and Admin API

Features a WebUI and Admin API for easy management of downstream servers, namespaces, roles, access, audit logs and tokens approximate token usage per namespace.

### Operating Modes

| Mode        | Tool Window                                                | Best For                                                                                                                                   |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Code**    | 2 tools: `gateway_run_code` + `gateway_help`               | Programmatic multi-tool orchestration in a JS sandbox - my tests shows better performance than compat mode, especially for large tool sets |
| **Compat**  | 2 meta-tools: `gateway_search_tools` + `gateway_call_tool` | Large tool sets, minimal context usage                                                                                                     |
| **Default** | All enabled downstream tools, filtered by namespace        | Full transparency, small tool sets                                                                                                         |

Modes are configured per namespace and can be mixed across different access paths. You can create a `mcp/dev` with complex tools to be used in code mode or `/mcp/personal` with a small set of tools to be used in compat mode for example.

### Session Management

- Persistent sessions backed by **SQLite** (default) or in-memory store
- Configurable TTL (default 30 minutes via `session.ttlSeconds` = 1800) with automatic cleanup
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
- **Bearer tokens** issued per user/service via the admin API or WebUI, mapped to roles in config (`static_key` auth)

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
const tools = await catalog.search('fastmcp docs', {
  serverId: 'fastmcp',
  requiredArgs: ['query'],
  detail: 'signature',
  k: 5,
})

// Call tools and process results
const details = await catalog.describe(tools[0].handle, { detail: 'signature' })
const out = await mcp.call(tools[0].handle, { query: 'quickstart' })
const filtered = result.limit(result.items(out), 1)
const text = result.text(out)

// Batch only tools with compatible args
if (tools.length >= 2) {
  const [a, b] = await mcp.batch([
    { handle: tools[0].handle, args: { query: 'quickstart' } },
    { handle: tools[1].handle, args: { query: 'installation' } },
  ])
}

// Store large results for later
const saved = await artifacts.save(filtered, { label: 'filtered-files' })
return { saved, count: result.count(filtered), sample: text }
```

The sandbox is memory- and time-limited (configurable). The model writes a script; the gateway executes it against real downstream tools and returns the result. `result` is a reserved global, snippets may be either a single expression or a block with `return`, and the final value should be JSON-friendly. `catalog.search()` accepts `k`, the compatibility alias `limit` (prefer `k`), and optional filters such as `serverId` and `requiredArgs` to make tool selection safer for LLMs. `catalog.describe(..., { detail: "signature" })` returns required args plus short property metadata (`type`, `description`, `enum` when available). `result.limit()` expects an array, while `result.items()` and `result.text()` help consume tool results that come back as `content[]`. For `mcp.batch`, only combine handles that accept the same arg shape; use `catalog.describe(..., { detail: "signature" })` when unsure and check that the search returned enough tools before indexing. For large or rich payloads, prefer `result.pick`, `result.limit`, `artifacts.save`, or `JSON.parse(JSON.stringify(value))`.

---

---

## Security

- **Local bind by default** — `HOST=127.0.0.1` prevents accidental network exposure
- **Client auth** — `static_key`: MCP clients use Bearer tokens created in the admin UI / admin API (bootstrap only carries `auth.mode`; tokens are not embedded in `bootstrap.json`)
- **Admin API protection** — set `ADMIN_TOKEN` to require `GATEWAY_ADMIN_USER` / `GATEWAY_ADMIN_PASSWORD` via `/admin/auth/login` (session cookie); in `NODE_ENV=production` with debug off and no `ADMIN_TOKEN`, admin routes are not mounted at all
- **Downstream credentials** — stored AES-encrypted in SQLite when `DOWNSTREAM_AUTH_ENCRYPTION_KEY` is set
- **Rate limiting** — per-session and per-user request limits via `@fastify/rate-limit`
- **Security headers** — `@fastify/helmet` applied to all responses
- **CORS** — restricted to loopback origins for MCP endpoints

See [docs/deployment.md](docs/deployment.md) for production hardening checklist.

### Local verification (pre-push / CI parity)

From the repo root, **`npm run verify`** (alias **`npm run ci`**, **`npm run prepush`**) runs: fresh `npm ci`, typecheck, lint, Vitest with coverage, `npm --prefix ui ci` + **`svelte-check`**, then **`npm run build`**. For day-to-day runs without reinstalling deps or building the UI, use **`npm test`** (typecheck + lint + tests via npm `pretest`) or **`npm run test:coverage`**.

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
| [CHANGELOG.md](CHANGELOG.md)                       | Release notes and current publication caveats              |
| [config/README.md](config/README.md)               | Config directory quick reference                           |

---

## License

MIT — see [package.json](package.json).
