# Getting started

## Requirements

- **Node.js** 22 or 24 LTS ([`package.json`](../package.json) `engines`)
- For Docker: Docker Engine and Compose v2

Operational note:

- `code` mode is supported on **Node 22/24 LTS** only
- avoid **Node 25** and other odd-numbered releases for both the gateway and local validation scripts

## Install and configure

```bash
git clone <repository-url>
cd mcpr-gateway
npm ci
npm run setup
```

[`npm run setup`](../scripts/setup.ts) is **optional**: creates `.env` from [`.env.example`](../.env.example) when missing, runs basic checks (Node, ports for full-stack dev, SQLite path), lets you edit common env vars, and **optionally** creates `config/bootstrap.json` (advanced / GitOps). You do **not** need `bootstrap.json` for the default flow: the gateway starts without it using built-in defaults and **no downstream servers** (see [Configuration](CONFIGURATION.md#missing-file)); runtime config then lives in SQLite and the Web UI.

For anything beyond local experimentation, use **`static_key`** auth (the only supported bootstrap mode). Add client access tokens in the **admin UI** (Access Control) after setting `ADMIN_TOKEN` and signing in with `GATEWAY_ADMIN_USER` / `GATEWAY_ADMIN_PASSWORD`.

For Docker Compose, the required variables (`ADMIN_TOKEN`, `GATEWAY_ADMIN_PASSWORD`, `DOWNSTREAM_AUTH_ENCRYPTION_KEY`) must be present in the host environment or passed via `docker compose --env-file .env ...`. The compose file does not load `.env` automatically.

**Advanced:** copy a bootstrap template manually:

```bash
cp config/bootstrap.example.json config/bootstrap.json
# Then tune file-backed config or use ${VAR} placeholders (missing vars → startup failure)
```

When `bootstrap.json` is missing, the process still starts with built-in defaults and **no downstream servers** (see [Configuration](CONFIGURATION.md#missing-file)).

## Run the gateway

**Full-stack local dev (default)** — Vite on `PORT`, API on `PORT + 1`:

```bash
npm run dev
```

**API process only** (single `HOST` / `PORT`, e.g. for MCP clients hitting `http://127.0.0.1:3000` directly):

```bash
npm run dev:gateway
```

For `code` mode stability, the gateway must run with `--no-node-snapshot`. The bundled dev scripts set this automatically.

Defaults:

- **Host:** `127.0.0.1` — loopback only; set `HOST=0.0.0.0` for Docker or LAN exposure
- **Port:** `3000` (`PORT`) — with `npm run dev`, the **UI** uses this port and the **gateway** uses `PORT + 1`

Full list of process environment variables: [Configuration — Process environment](CONFIGURATION.md#process-environment).

**Docker runtime** — bundled UI and MCP share the same port (`PORT`, default `3000`):

```bash
docker compose -f docker/docker-compose.yml up --build
```

## MCP over HTTP

The gateway exposes one MCP HTTP endpoint per namespace:

```http
GET  /mcp/:namespace
POST /mcp/:namespace
Content-Type: application/json
Authorization: Bearer <token>   # optional; depends on auth.mode
```

Supported methods (see [`src/gateway/routes/mcp.ts`](../src/gateway/routes/mcp.ts)):

| Method            | Notes                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `initialize`      | Creates a session; response includes MCP result; **`Mcp-Session-Id` response header** carries the session id |
| `tools/list`      | Returns the current tool window for the session (header `Mcp-Session-Id` required)                           |
| `tools/call`      | Executes a tool via the gateway router                                                                       |
| `notifications/*` | JSON-RPC notifications such as `notifications/initialized`; no `id` required                                 |

Typical client flow:

1. `POST /mcp/my-namespace` with `initialize` → store `Mcp-Session-Id`
2. Send `tools/list` and `tools/call` with the same header

For streamable HTTP clients such as MCP Inspector, ChatGPT, or Claude:

1. Open `GET /mcp/my-namespace` to establish the SSE stream
2. `POST initialize` and store `Mcp-Session-Id`
3. `POST notifications/initialized`
4. Continue with `tools/list` and `tools/call`

Invalid namespace or body returns **400** with error details.
Tool and downstream execution failures are returned as **HTTP 200** with a JSON-RPC `error` object in the body. Treat the JSON-RPC payload as the source of truth, not the HTTP status alone.

### Codex CLI

For Codex CLI, configure the MCP server URL plus a bearer token environment variable. Do not place a bare
`Authorization = "Bearer ..."` key inside the TOML server block, because Codex does not treat that as an HTTP header
for streamable HTTP MCP servers.

```toml
[mcp_servers.mcpr-gateway]
url = "http://127.0.0.1:3000/mcp/all"
bearer_token_env_var = "MCPR_GATEWAY_TOKEN"
```

```bash
export MCPR_GATEWAY_TOKEN=<client-access-token>
codex
```

If Codex sends `initialize` without the bearer token, the handshake often fails with a response decoding error before
any tools are listed.

Some MCP clients may also omit the JSON-RPC `result` body from what they show to the model even when the gateway request succeeded. When diagnosing `code` mode, compare the client view with a raw HTTP request to `/mcp/:namespace` before assuming the gateway lost the payload.

### Example: Hosted MCP with a bearer token

Some hosted MCP endpoints return `401` until the gateway sends a valid bearer token. A generic env-backed setup looks like:

```json
{
  "servers": [
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
  ]
}
```

```bash
export MCP_SERVER_TOKEN=<your-downstream-token>
```

## Authentication

Configured in `bootstrap.json` under `auth`:

| `auth.mode`  | Behavior                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static_key` | `Authorization: Bearer <token>` must match a key in `auth.staticKeys` to obtain `userId` and `roles`. Otherwise the request is treated as `anonymous` with no roles. |

The legacy value `mock_dev` is **not** accepted in `bootstrap.json` — the process exits at startup if it appears.

Implementation: [`src/auth/service.ts`](../src/auth/service.ts).

Recommended usage:

- Prefer **client access tokens** created in the Access Control panel (stored in the DB when using SQLite).
- You may seed `auth.staticKeys` in `bootstrap.json` for bootstrap-only keys; optional `${VAR}` interpolation applies to string values in that file.

Authorization to use a namespace and mode is enforced in policy resolution during `initialize` ([`src/gateway/dispatch/initialize.ts`](../src/gateway/dispatch/initialize.ts)).

## Web UI

If static files exist under `ui/dist` or `ui/build` (or `UI_STATIC_DIR`), the server redirects `/` to `/ui/`. Build the UI once with:

```bash
npm run build:ui
```

See [Development](DEVELOPMENT.md#web-ui) for day-to-day UI work (`npm run dev` runs Vite + gateway together).

## Next steps

| Guide | What's in it |
| ----- | ------------ |
| [Configuration](CONFIGURATION.md) | All `bootstrap.json` sections, env interpolation, two-tier model |
| [HTTP API](reference/HTTP-API.md) | Health, admin, debug routes — full endpoint reference |
| [Deployment](DEPLOYMENT.md) | Docker Compose, persistence, admin protection, TLS |
| [Development](DEVELOPMENT.md) | Scripts, project layout, test strategy, UI workflow |
| [Architecture](ARCHITECTURE.md) | Components, request flow, session lifecycle |
