# Configuring MCPR Gateway

**Documentation index:** [Getting Started](GETTING-STARTED.md) · [Architecture](ARCHITECTURE.md) · [HTTP API](reference/HTTP-API.md) · [Deployment](DEPLOYMENT.md) · [Development](DEVELOPMENT.md)

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
│  • auth: ALWAYS merged from file (secrets management)           │
│  • servers, namespaces, policies: used to seed SQLite           │
│                                                                 │
│  After first start, changes to this file are IGNORED            │
│  runtime saves can manage auth too; bootstrap remains optional  │
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
The published compose preset also loads the repo-root `.env` into the container with production-safe defaults.

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
| `auth`         | Inbound client auth section. It can be seeded from `bootstrap.json`, but normal operation may manage it from the WebUI/runtime config. See [`AuthConfigSchema`](../src/config/schemas.ts). |
| `namespaces`   | Per-namespace tool window sizes and allowed modes/roles.                                                                                                                                                                 |
| `roles`        | Which namespaces each role may use and optional `denyModes`.                                                                                                                                                             |
| `selector`     | BM25/lexical ranking, discovery-tool controls, scoring penalties, and **`publication`** (how descriptions and schemas are projected to MCP clients). See [Selector publication](#selector-publication).                  |
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

### Selector publication

The gateway builds **toolcards** from downstream tools (sanitized descriptions and stable names; see [`src/toolcard/sanitizer.ts`](../src/toolcard/sanitizer.ts)). What MCP clients receive in `tools/list` and related responses is the **public projection** of each tool: descriptions and input schemas can optionally be compressed under `selector.publication` ([`src/gateway/publish/project.ts`](../src/gateway/publish/project.ts), [`src/gateway/publish/compress.ts`](../src/gateway/publish/compress.ts)).

| Field                    | Type                    | Default | Purpose                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `descriptionCompression` | `off` or `conservative` | `off`   | **`off`:** publication leaves descriptions unchanged. **`conservative`:** shortens text using heuristics (first sentence, trim before phrases like “for example” / “e.g.”, strips common “use this tool…” boilerplate, normalizes whitespace) before any length cap. |
| `schemaCompression`      | `off` or `conservative` | `off`   | **`off`:** input schemas are passed through unchanged. **`conservative`:** drops doc-only JSON Schema keys and runs the same description compression on nested `description` strings (depth-limited).                                                                |
| `descriptionMaxLength`   | integer ≥ 0             | `0`     | Applies only when `descriptionCompression` is **`conservative`**. **`0`** means **no character cap** after the conservative heuristics. A **positive** value applies a word-aware truncation with an ellipsis. Ignored when description compression is **`off`**.    |

Sanitization (strip HTML, noisy markdown emphasis markers, strip unsafe control characters, normalize CRLF to `\n`, collapse horizontal spaces/tabs within each line, cap runs of 3+ blank lines to a single paragraph break) happens when toolcards are generated and is **independent** of publication: turning publication **`off`** does not skip the sanitizer. **Newlines between lines are preserved**, so paragraph breaks and list line breaks from the downstream tool stay visible in toolcards and in **Tools → Customize** unless **conservative** description compression flattens text for clients. The effective description and schema in the admin view match the **published** shape (`projectToPublic`), aligning with what typical MCP clients see after projection.

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

If `DOWNSTREAM_AUTH_ENCRYPTION_KEY` is present but malformed, the gateway now fails fast during startup instead of silently disabling managed secret storage.

Managed downstream credentials are stored in SQLite separately from `configJson` and encrypted at rest. Downstream auth via `auth.source: env` / `literal` or legacy static `headers` does not use that store. **`SESSION_BACKEND=memory` disables SQLite** — managed downstream secrets cannot be persisted in that mode.

### OAuth provider allowlist

The gateway also supports an optional allowlist for upstream OAuth providers:

- config key: `allowedOAuthProviders`
- UI location: **Configuration** page
- storage: admin-managed config (SQLite when available, file mode otherwise)

Behavior:

- empty list: OAuth is allowed only for HTTPS endpoints that pass the built-in SSRF checks
- non-empty list: OAuth start/registration is restricted to matching origins or wildcard patterns such as `*.example.com`
- the list is operator-managed and is not auto-populated from successful logins

## Environment interpolation

Before parsing JSON, the file is read as text and **placeholders** in the form `${VAR_NAME}` are replaced with the value of that environment variable. Names must match `[A-Z_][A-Z0-9_]*`.

If any referenced variable is **missing**, the process logs an error and **exits**. This is commonly used for API keys in `auth.staticKeys` (see `config/bootstrap.example.json`).

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

- **Bootstrap auth can seed the instance**, but the active auth config may also be managed from the WebUI/runtime config.
- **`servers`, namespaces, roles, selector, session, triggers, resilience, debug, and starter packs** can be managed from the WebUI and are versioned in SQLite.
- **Client access tokens** are managed from the WebUI and persisted in the admin config slice inside SQLite.
- The admin API `GET /admin/config` returns the admin-managed config plus a read-only auth summary.
- `GET /admin/config/export` returns the admin-managed config slice as JSON.
- `GET /admin/config/versions` returns version history from SQLite (empty when not using SQLite).

## Which token do I use?

- **Client access token**: used by MCP clients on `/mcp/:namespace`
- **Admin access**: not a Bearer token. When `ADMIN_TOKEN` is set, call `POST /admin/auth/login` with `GATEWAY_ADMIN_USER` / `GATEWAY_ADMIN_PASSWORD`, then send the `admin_session` cookie on `/admin/*` (the WebUI does this automatically).
- When `ADMIN_TOKEN` is set, `GATEWAY_ADMIN_PASSWORD` must be non-empty; startup fails fast if it is missing.

Typical MCP client header:

```http
Authorization: Bearer <client-access-token>
```

Codex CLI expects this bearer token to be supplied through `bearer_token_env_var` in `~/.codex/config.toml`, for
example:

```toml
[mcp_servers.mcpr-gateway]
url = "http://127.0.0.1:3000/mcp/default"
bearer_token_env_var = "MCPR_GATEWAY_TOKEN"
```

Typical admin request after login:

```http
Cookie: admin_session=<value-from-set-cookie>
```

## MCP client authentication (inbound)

Bootstrap `auth.mode` is a discriminated union (see [`AuthConfigSchema`](../src/config/schemas.ts) and [`oauth-schemas.ts`](../src/config/oauth-schemas.ts)):

| `mode`       | Behavior |
| ------------ | -------- |
| `static_key` | Map `Authorization: Bearer <token>` against `auth.staticKeys` (bootstrap and/or admin). Unknown/missing token → `anonymous`. |
| `oauth`      | Resource-server style: expect an access token JWT from a configured issuer. Missing/invalid token on protected namespaces and SSE connects → **401** and `WWW-Authenticate` with `resource_metadata` (RFC 9728). |
| `hybrid`     | Try static keys first; if no match and OAuth applies to the namespace, validate JWT as in `oauth`. |

**JWT / OAuth:** `oauth.publicBaseUrl` must be the HTTPS origin clients use to reach the gateway in production. The gateway validates `aud` against `publicBaseUrl + /mcp/{namespace}` unless an issuer entry sets a custom `audience`. Issuer `issuer` URLs must match the JWT `iss` claim. Optional `jwksUri`; otherwise JWKS URL is discovered (OpenID discovery, OAuth authorization-server metadata, then `/.well-known/jwks.json`). Role strings are read from the claim named by `rolesClaim` (default `roles`).

**Metadata:** Clients can fetch protected-resource metadata at:

- `GET /.well-known/oauth-protected-resource/mcp/:namespace`
- `GET /mcp/:namespace/.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-authorization-server/mcp/:namespace`
- `GET /mcp/:namespace/.well-known/oauth-authorization-server`
- `GET /.well-known/openid-configuration`
- `GET /.well-known/openid-configuration/mcp/:namespace`
- `GET /mcp/:namespace/.well-known/openid-configuration`

These metadata endpoints return browser CORS headers for loopback origins and for exact matches from `auth.oauth.allowedBrowserOrigins`. Configured entries are treated as origins, not prefixes or wildcard patterns.

`auth.oauth.allowedBrowserOrigins` is only a browser `Origin`/CORS allowlist for the metadata routes and `/mcp/:namespace`. It is **not** an OAuth redirect/callback URI allowlist.

For `provider: "embedded"`, remote clients register their own `redirect_uris` through dynamic client registration (`POST /oauth/register`). For external issuers, configure callback allowlists in the upstream IdP itself. For Claude remote MCP connectors, Anthropic currently documents `https://claude.ai/api/mcp/auth_callback` and recommends also allowing `https://claude.com/api/mcp/auth_callback`.

The protected-resource routes identify this gateway resource (`resource`, `authorization_servers`, `scopes_supported`). The authorization-server and OpenID routes proxy normalized issuer discovery metadata from the configured inbound IdP and include `resource` on namespace-specific aliases.

When `auth.mode` is `static_key` only, all of these URLs return **404**.

The legacy `auth.mode` value `mock_dev` is rejected at startup.

## Client bearer authentication (`static_key`)

For each MCP request in `static_key` or `hybrid`, the gateway resolves the caller from `Authorization: Bearer <token>` when using static keys:

- If the token matches an entry in effective `auth.staticKeys` (bootstrap and/or admin-managed tokens), `sub` and `roles` come from that entry.
- If the header is missing or the token is unknown **and** OAuth does not apply to this namespace, the caller is `sub = "anonymous"` and `roles = []`.

Namespace access requires both:

- the namespace lists at least one of the caller roles in `namespaces[namespace].allowedRoles`, and
- that role includes the namespace in `roles[role].allowNamespaces`.

## Examples

In `config/`:

- `bootstrap.example.json` — template `bootstrap.json` with `static_key` (no placeholder keys; add tokens via the Web UI or `auth.staticKeys`).

Optional: run `npm run setup` and choose to create `config/bootstrap.json` (advanced), or copy `bootstrap.example.json` manually. The default workflow needs no bootstrap file—use the WebUI for downstream servers and policies with SQLite-backed config.

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
