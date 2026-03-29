# HTTP API reference

Base URL is wherever the gateway listens (`HOST`/`PORT`). All paths below are relative to that origin.

## MCP (JSON-RPC)

| Method    | Path              | Description                                                                 |
| --------- | ----------------- | --------------------------------------------------------------------------- |
| `GET`     | `/mcp/:namespace` | SSE stream endpoint for streamable HTTP clients                             |
| `POST`    | `/mcp/:namespace` | Single endpoint for MCP JSON-RPC (`initialize`, `tools/list`, `tools/call`) |
| `OPTIONS` | `/mcp/:namespace` | Browser preflight for loopback web clients (for example MCP Inspector)      |

### OAuth protected-resource metadata (RFC 9728)

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/.well-known/oauth-protected-resource/mcp/:namespace` | JSON metadata: `resource`, `authorization_servers`, `scopes_supported`, … when `auth.mode` is `oauth` or `hybrid` |
| `GET` | `/mcp/:namespace/.well-known/oauth-protected-resource` | Same document (alternate path for some clients) |

If inbound OAuth is disabled (`static_key` only), these routes return **404**.

- **Namespace:** URL segment must satisfy server validation (invalid → 400).
- **Body:** JSON-RPC object; request methods require `id`, notifications may omit it; unsupported `method` → gateway error ([`src/gateway/routes/mcp.ts`](../src/gateway/routes/mcp.ts)).
- **Session:** After `initialize`, clients must send **`Mcp-Session-Id`** on subsequent requests (header) for `tools/list` and `tools/call`.
- **Browser CORS:** Without inbound OAuth browser allowlist, MCP responses use the existing loopback-only CORS behavior. When `auth.oauth.allowedBrowserOrigins` is set (see config schemas), browsers sending `Origin` must exactly match those entries as origins, not prefixes or wildcard patterns (loopback still allowed). The protected-resource metadata routes emit the same CORS headers for allowed origins. Non-browser clients without an `Origin` header are not blocked by that check.
- **Client auth:** With **`static_key`** or **`hybrid`**, send `Authorization: Bearer <client-access-token>` for pre-mapped tokens. With **`oauth`** / **`hybrid`** (and OAuth applicable to the namespace), send a Bearer **JWT** from a configured issuer; missing or invalid tokens return **401** with `WWW-Authenticate` including `resource_metadata="…"`. Unsupported request `Content-Type` on POST may return **415**.
- **Codex CLI auth:** For Codex streamable HTTP servers, configure `bearer_token_env_var` in `~/.codex/config.toml`. A bare `Authorization = "Bearer ..."` entry in the server block is not interpreted as an HTTP header by Codex.
- **JSON-RPC errors:** Tool failures, validation failures, and downstream failures often return **HTTP 200** with a JSON-RPC `error` object in the body. Clients must inspect the JSON-RPC payload, not only the HTTP status.
- **Client display caveat:** Some MCP clients may not surface the full JSON-RPC `result` payload to the model even when the gateway returned it successfully. For server-side diagnosis, compare client behavior with a raw HTTP JSON-RPC request.

Hybrid compatibility on the same route:

1. Legacy clients can keep using `POST initialize` followed by `POST tools/list` / `POST tools/call` with `Mcp-Session-Id`.
2. Streamable HTTP clients can open `GET /mcp/:namespace` for SSE, then use `POST` requests and notifications such as `notifications/initialized`.

## Health

| Method | Path       | Description          |
| ------ | ---------- | -------------------- |
| `GET`  | `/health`  | `{ "status": "ok" }` |
| `GET`  | `/healthz` | Same                 |
| `GET`  | `/readyz`  | Same                 |

## Registry maintenance

| Method | Path                | Description                                                                          |
| ------ | ------------------- | ------------------------------------------------------------------------------------ |
| `POST` | `/registry/refresh` | Refreshes all downstream registrations. **Loopback clients only**; otherwise **403** |

## Debug (when `debug.enabled` in config)

Registered only when debug is enabled ([`src/index.ts`](../src/index.ts)). **Loopback only**; otherwise **403**.

| Method | Path                  | Description                     |
| ------ | --------------------- | ------------------------------- |
| `GET`  | `/debug/session/:id`  | Session payload or 404          |
| `GET`  | `/debug/selector/:id` | Last selector trace for session |
| `GET`  | `/debug/registry`     | Servers and tool counts         |
| `GET`  | `/debug/health`       | Registry health states          |

Implementation: [`src/gateway/routes/debug.ts`](../src/gateway/routes/debug.ts).

## Admin API

Admin routes are registered when **any** of the following holds ([`src/index.ts`](../src/index.ts)):

- `debug.enabled` in config, or
- `ADMIN_TOKEN` environment variable is set, or
- `NODE_ENV` is not `production`

### Admin authentication

- **`/admin/auth/*`** — No prior auth (used to log in).
- **All other `/admin/*`** — If `ADMIN_TOKEN` is set: require a valid `admin_session` cookie from `POST /admin/auth/login` (`GATEWAY_ADMIN_USER` / `GATEWAY_ADMIN_PASSWORD`). If `ADMIN_TOKEN` is **unset**, no admin auth hook runs (any caller can hit admin routes **when they are registered** — see [Deployment](../DEPLOYMENT.md#admin-api-and-production)).

### Core routes (always present when admin is enabled)

| Method | Path                 | Description                                                                              |
| ------ | -------------------- | ---------------------------------------------------------------------------------------- |
| `POST` | `/admin/auth/login`  | Body `{ "username", "password" }`; sets `admin_session` cookie when `ADMIN_TOKEN` is set |
| `POST` | `/admin/auth/logout` | Clears cookie                                                                            |
| `GET`  | `/admin/auth/me`     | `{ "authenticated": boolean }`                                                           |
| `GET`  | `/admin/dashboard`   | Aggregated stats (sessions, servers, tools, recent audit if SQLite)                      |

### When session store is available

| Method   | Path                  | Description                                     |
| -------- | --------------------- | ----------------------------------------------- |
| `GET`    | `/admin/sessions`     | Query: `namespace`, `status`, `limit`, `offset` |
| `GET`    | `/admin/sessions/:id` | Session detail                                  |
| `DELETE` | `/admin/sessions/:id` | Revoke session                                  |

### When registry is available

| Method | Path             | Description                                                     |
| ------ | ---------------- | --------------------------------------------------------------- |
| `GET`  | `/admin/servers` | Servers with health and tool counts                             |
| `GET`  | `/admin/tools`   | Query: `namespace`, `server_id`, `search` — flattened tool list |

### When audit repository is available (SQLite)

| Method   | Path                 | Description                                                                                        |
| -------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `GET`    | `/admin/audit`       | Query filters: `session_id`, `user_id`, `event_type`, `tool_name`, `from`, `to`, `limit`, `offset` |
| `DELETE` | `/admin/audit/prune` | Query: `days` (default `AUDIT_RETENTION_DAYS` or 90)                                               |

### When config management is available

| Method   | Path                              | Description                                                                                                                                                                                               |
| -------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/admin/config`                   | Admin-managed config + read-only auth summary + `source`                                                                                                                                                  |
| `POST`   | `/admin/config`                   | Replace admin config (validated); optional headers `x-user-id`, `x-comment`                                                                                                                               |
| `GET`    | `/admin/config/versions`          | Version list from SQLite (`[]` when `SESSION_BACKEND=memory`)                                                                                                                                             |
| `POST`   | `/admin/config/rollback/:version` | Roll back to version number                                                                                                                                                                               |
| `GET`    | `/admin/config/export`            | JSON export of admin slice                                                                                                                                                                                |
| `GET`    | `/admin/config/servers`           | Current `servers` array                                                                                                                                                                                   |
| `POST`   | `/admin/config/servers`           | Append server                                                                                                                                                                                             |
| `PUT`    | `/admin/config/servers/:id`       | Patch server by id                                                                                                                                                                                        |
| `DELETE` | `/admin/config/servers/:id`       | Remove server                                                                                                                                                                                             |
| `GET`    | `/admin/config/policies`          | Namespaces, roles, selector, session, triggers, resilience, debug, starter packs, `codeMode`, `allowedOAuthProviders`; auth token state is returned for display but managed by dedicated auth endpoints |
| `PUT`    | `/admin/config/policies`          | Update policy sections only; does not overwrite bearer tokens or other auth state                                                                                                                         |
| `GET`    | `/admin/namespaces`               | Namespace list for admin UI: `metrics` (MCP `tools/list` token estimates, plus compat/code `initializeInstructionsTokens` and `firstTurnEstimatedTokens`), `catalogMetrics` (downstream catalog), `tools` |

Implementation: [`src/gateway/routes/admin.ts`](../src/gateway/routes/admin.ts).

## Static Web UI

When a UI build directory is resolved ([`src/gateway/routes/ui.ts`](../src/gateway/routes/ui.ts)):

| Method | Path    | Description                                |
| ------ | ------- | ------------------------------------------ |
| `GET`  | `/`     | Redirect to `/ui/`                         |
| `GET`  | `/ui`   | Redirect to `/ui/`                         |
| `GET`  | `/ui/*` | Static files; SPA fallback to `index.html` |

Search order for the directory: `UI_STATIC_DIR`, then `ui/dist`, then `ui/build` under the process cwd.
