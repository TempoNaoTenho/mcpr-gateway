# Configuring MCP Session Gateway

**Documentation index:** [docs/README.md](README.md) — getting started, architecture, HTTP API, deployment, and development guides.

## Bootstrap vs Runtime Config

The gateway uses a **two-tier configuration model**:

| Tier          | Source                                | Purpose                                             |
| ------------- | ------------------------------------- | --------------------------------------------------- |
| **Bootstrap** | `CONFIG_PATH/bootstrap.json`          | Initial config; ALWAYS sources `auth` (secrets)     |
| **Runtime**   | SQLite database (`./data/gateway.db`) | Admin-managed config; servers, namespaces, policies |

```
┌─────────────────────────────────────────────────────────────────┐
│                     bootstrap.json                              │
│           (BOOTSTRAP ONLY - used once on first start)           │
│                                                                 │
│  • auth: ALWAYS merged from file (secrets management)          │
│  • servers, namespaces, policies: used to seed SQLite          │
│                                                                 │
│  After first start, changes to this file are IGNORED           │
│  (except for auth which is always merged from the file)        │
└─────────────────────┬───────────────────────────────────────────┘
                      │ First startup only (if SQLite is empty)
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SQLite (gateway.db)                         │
│        (AUTHORITATIVE - all admin panel operations go here)     │
│                                                                 │
│  • servers: downstream MCP servers                              │
│  • namespaces: per-namespace policies                           │
│  • roles: role definitions                                      │
│  • selector, session, triggers, resilience, debug: settings   │
│  • starterPacks: cold-start preferences                        │
│                                                                 │
│  Changes via admin panel persist here; bootstrap.json ignored  │
└─────────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Admin Panel (Web UI)                         │
│        Reads/writes SQLite, NOT bootstrap.json                  │
│                                                                 │
│  If you edit bootstrap.json after first start,                  │
│  your changes will NOT appear in the admin panel               │
│  (except for auth which is ALWAYS merged from the file)         │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight:** `bootstrap.json` is for initial setup and auth secrets. The admin panel manages runtime config through SQLite. If you want to change namespaces/servers after first boot, use the admin panel, not the file.

## Location

- **Default directory:** `./config` (repository root).
- **Override:** set the `CONFIG_PATH` environment variable to an absolute or relative path to that directory (not to the file itself). The gateway loads `CONFIG_PATH/bootstrap.json`.

Docker and compose examples mount `./config` at `/config` and set `CONFIG_PATH=/config`.

## Process environment

These environment variables control how the HTTP process is exposed. They are intentionally kept outside `bootstrap.json`, which remains focused on gateway bootstrap and auth secrets.

- `HOST` controls which address the Fastify server binds to. Default: `127.0.0.1`.
- `PORT` controls the HTTP port. Default: `3000`.
- `UI_STATIC_DIR` optionally overrides the directory used to serve the built WebUI. When unset, the gateway looks for `ui/dist` and then `ui/build` under the current working directory.

Typical values:

- Local-only development: `HOST=127.0.0.1`
- Docker or remote exposure: `HOST=0.0.0.0`

This default is intentional: binding to loopback avoids accidentally exposing admin or debug-capable endpoints on a shared network. Use `0.0.0.0` only when the deployment model requires external reachability and you have the expected network controls in place.

## File format

`bootstrap.json` may be a minimal bootstrap object or a full config object. These top-level sections are recognized:

| Section        | Purpose                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `servers`      | Downstream MCP servers (stdio or HTTP). Optional in the file; the WebUI can manage them later. See [`DownstreamServerSchema`](../src/types/server.ts).                                                                   |
| `auth`         | Bootstrap auth section. **ALWAYS sourced from file** (merged at runtime). In normal use, client Bearer tokens are managed from the WebUI and stored in `staticKeys`. See [`AuthConfigSchema`](../src/config/schemas.ts). |
| `namespaces`   | Per-namespace tool window sizes and allowed modes/roles.                                                                                                                                                                 |
| `roles`        | Which namespaces each role may use and optional `denyModes`.                                                                                                                                                             |
| `selector`     | BM25/lexical ranking settings, discovery-tool controls, and scoring penalties.                                                                                                                                           |
| `session`      | Session TTL, cleanup interval, and handle TTL (`handleTtlSeconds`).                                                                                                                                                      |
| `code`         | Code mode execution config, including `maxConcurrentToolCalls` to limit parallel batch execution.                                                                                                                        |
| `triggers`     | When to refresh the tool window after tool calls.                                                                                                                                                                        |
| `resilience`   | Timeouts, rate limits, circuit breaker.                                                                                                                                                                                  |
| `debug`        | Whether debug HTTP routes may be registered.                                                                                                                                                                             |
| `starterPacks` | Cold-start preferences per namespace (keys must match `namespaces`).                                                                                                                                                     |

The authoritative Zod schemas live in [`src/config/schemas.ts`](../src/config/schemas.ts). The on-disk schema accepts omitted sections and fills defaults at load time.

### Session and Code execution options

The `session` and `code` sections control resource management:

| Option                   | Section   | Default | Purpose                                                                                                     |
| ------------------------ | --------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `handleTtlSeconds`       | `session` | `300`   | TTL for session-scoped handles (in seconds). Handles older than this are eligible for cleanup.              |
| `maxConcurrentToolCalls` | `code`    | `5`     | Maximum parallel tool calls in code mode. Limits concurrent batch execution to prevent resource exhaustion. |

Both values can be overridden per-namespace via the admin API.

## Downstream HTTP authentication

HTTP and streamable HTTP downstream servers support two patterns:

- legacy static headers via `servers[].headers`
- explicit downstream auth via `servers[].auth`

Supported downstream auth modes:

- `none`
- `bearer`
- `oauth`

Example bearer config using an environment variable:

```json
{
  "id": "example-hosted",
  "namespaces": ["default"],
  "transport": "streamable-http",
  "url": "https://mcp.example.com/mcp",
  "auth": {
    "mode": "bearer",
    "source": { "type": "env", "envVar": "MCP_SERVER_TOKEN" }
  },
  "enabled": true,
  "trustLevel": "verified"
}
```

Legacy `headers.Authorization` remains supported for backward compatibility.

### Managed downstream credentials

UI-managed bearer secrets and downstream OAuth tokens require:

- `DOWNSTREAM_AUTH_ENCRYPTION_KEY` set to a base64-encoded 32-byte key

Managed downstream credentials are stored in SQLite separately from `configJson` and encrypted at rest. Downstream auth via `auth.source: env` / `literal` or legacy static `headers` does not use that store. **`SESSION_BACKEND=memory` disables SQLite** — managed downstream secrets cannot be persisted in that mode.

## Environment interpolation

Before parsing JSON, the file is read as text and **placeholders** in the form `${VAR_NAME}` are replaced with the value of that environment variable. Names must match `[A-Z_][A-Z0-9_]*`.

If any referenced variable is **missing**, the process logs an error and **exits**. This is commonly used for API keys in `auth.staticKeys` (see `gateway.production.example.json`).

## Missing file

If `bootstrap.json` does not exist, the gateway starts with **no downstream servers** and **built-in default policies** (including a `default` namespace). A warning is printed.

## Security

- Do **not** commit real client tokens or admin tokens. Use placeholders in examples and inject secrets via env interpolation in `bootstrap.json` only when you choose that pattern (e.g. `${SOME_VAR}` in `staticKeys`), or manage tokens from the admin UI.
- Restrict file permissions on `bootstrap.json` in production.

## Config persistence

| `SESSION_BACKEND`                          | Behavior                                                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(unset or any value other than `memory`)_ | **SQLite** (default file `./data/gateway.db`, or `DATABASE_PATH`). Sessions, audit, config **versions**, and managed downstream auth rows live in the DB. On first start, the active config row is bootstrapped from `bootstrap.json`. |
| `memory`                                   | **No SQLite file.** Sessions are in-process only. Admin saves go to **`CONFIG_PATH/bootstrap.json`**; there is **no** version history, no SQLite audit sink, and no persisted managed downstream secrets.                              |

In the SQLite case:

- **Bootstrap auth still comes from `bootstrap.json`** (merged with the active SQLite row at runtime).
- **`servers`, namespaces, roles, selector, session, triggers, resilience, debug, and starter packs** can be managed from the WebUI and are versioned in SQLite.
- **Client access tokens** are managed from the WebUI and persisted in the admin config slice inside SQLite.
- The admin API `GET /admin/config` returns the admin-managed config plus a read-only auth summary.
- `GET /admin/config/export` returns the admin-managed config slice as JSON.
- `GET /admin/config/versions` returns version history from SQLite (empty when not using SQLite).

## Which token do I use?

- **Client access token**: used by MCP clients on `/mcp/:namespace`
- **Admin panel token**: used by the WebUI and `/admin/*`

Typical MCP client header:

```http
Authorization: Bearer <client-access-token>
```

Codex CLI expects this bearer token to be supplied through `bearer_token_env_var` in `~/.codex/config.toml`, for
example:

```toml
[mcp_servers.mcp-session-gateway]
url = "http://127.0.0.1:3000/mcp/all"
bearer_token_env_var = "MCP_SESSION_GATEWAY_TOKEN"
```

Typical admin header:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

## `mock_dev` authentication behavior

`mock_dev` is intentionally strict about roles:

- No `Authorization` header means the request resolves to `sub = "anonymous"` and `roles = []`.
- `Authorization: Bearer <userId>` gives that `userId` but still no roles.
- `Authorization: Bearer <userId>:<role1,role2>` sets both the user id and roles.

This matters for namespace access because a request is allowed only when:

- the namespace includes at least one of the caller roles in `namespaces[namespace].allowedRoles`, and
- the matching role also includes that namespace in `roles[role].allowNamespaces`.

For local tools like MCP Inspector, a typical header is:

```http
Authorization: Bearer inspector:user
```

## Examples

In `config/`:

- `gateway.example.json` — sample server + `static_key` auth (placeholder keys).
- `gateway.local.example.json` — minimal local bootstrap (`mock_dev` + debug enabled).
- `gateway.production.example.json` — minimal production bootstrap (`static_key` with `${GATEWAY_API_KEY}`).

Run `npm run setup` to copy a local or production bootstrap profile to `config/bootstrap.json`, then use the WebUI for the rest.

For Docker Compose, set `HOST=0.0.0.0` and, if needed, `UI_STATIC_DIR=/app/ui/dist` so the bundled server can always locate the built WebUI inside the container.

## Migrating from YAML

Older versions used `servers.yaml`, `policies.yaml`, and optionally `starter-packs.yaml`. Merge them into one object:

1. Set `servers` from the old `servers` array.
2. Copy `auth`, `namespaces`, `roles`, `selector`, `session`, `triggers`, `resilience`, `debug` from policies.
3. Set `starterPacks` from the former `starterPacks` key (or from `starter-packs.yaml`).

Validate by starting the gateway or by checking against the Zod schemas in code.

## Resetting to Bootstrap

If you want to reset the runtime config back to match `bootstrap.json`:

```bash
# Stop the gateway
# Delete the SQLite database to force a fresh bootstrap
rm ./data/gateway.db
# Start the gateway again
npm run dev
```

This will re-load namespaces, servers, and policies from `bootstrap.json`.
