# Getting started

## Requirements

- **Node.js** 24 LTS ([`package.json`](../package.json) `engines`, [`.nvmrc`](../.nvmrc), [`.node-version`](../.node-version))
- For Docker: Docker Engine and Compose v2

Operational note:

- `code` mode is supported on **Node 24 LTS**

## Install and configure

```bash
git clone https://github.com/TempoNaoTenho/mcpr-gateway.git
cd mcpr-gateway
cp .env.example .env
npm ci
npm run build
npm start
```

[`npm run build`](../scripts/build.mjs) is the standard build entrypoint. It validates Node 24, rebuilds `isolated-vm` / `better-sqlite3` if they were compiled for another Node version, and produces the production UI and gateway artifacts.

Copy [`.env.example`](../.env.example) to `.env`, then replace every `change-me-*` placeholder before `npm start`. In hosted environments, you can inject the same variables directly from the platform instead of creating `.env`. `npm start` loads `.env` only when it exists and fails fast if any required security value is still empty, malformed, or unchanged from the example file.

`npm start` and `npm run dev` also try a one-time automatic rebuild of stale `isolated-vm` / `better-sqlite3` binaries when they detect an ABI mismatch from an older Node install. `npm run setup` remains an optional local convenience helper when you want guided editing of env vars or to create `config/bootstrap.json` (advanced / GitOps). You do **not** need `bootstrap.json` for the default flow: the gateway starts without it using built-in defaults and **no downstream servers** (see [Configuration](CONFIGURATION.md#missing-file)); runtime config then lives in SQLite and the Web UI.

By default, a fresh install starts in **`hybrid`** client-auth mode with bearer tokens available immediately and inbound OAuth left passive until you configure an issuer in the admin UI. That keeps simple MCP clients working while making web-client OAuth a first-class setup path instead of a separate mode switch.

For Docker Compose, the required variables (`ADMIN_TOKEN`, `GATEWAY_ADMIN_PASSWORD`, `DOWNSTREAM_AUTH_ENCRYPTION_KEY`) must be present in the host environment or passed via `docker compose --env-file .env ...`. Use an explicit env file or export the variables in your shell before `docker compose up`.

**Advanced:** copy a bootstrap template manually:

```bash
cp config/bootstrap.example.json config/bootstrap.json
# Then tune file-backed config or use ${VAR} placeholders (missing vars → startup failure)
```

When `bootstrap.json` is missing, the process still starts with built-in defaults and **no downstream servers** (see [Configuration](CONFIGURATION.md#missing-file)).

## Run the gateway

**Default built runtime** — static UI + MCP gateway on one port:

```bash
npm start
```

Open `http://127.0.0.1:3000`. The built admin UI is served by the gateway under `/ui/`, and MCP clients use the same `PORT`.

**Full-stack local dev** — Vite on `PORT`, API on `PORT + 1`:

```bash
npm run dev
```

Open `http://127.0.0.1:3000` for the local UI. During this integrated dev flow, the gateway API listens on `http://127.0.0.1:3001`. The `/ui/` path is the static built UI path used by `npm start`, `npm run build`, and Docker.

**API process only** (single `HOST` / `PORT`, e.g. for MCP clients hitting `http://127.0.0.1:3000` directly):

```bash
npm run dev:gateway
```

For `code` mode stability, the gateway must run with `--no-node-snapshot`. The bundled dev scripts set this automatically.

Defaults:

- **Host:** `127.0.0.1` — loopback only; set `HOST=0.0.0.0` for Docker or LAN exposure
- **Port:** `3000` (`PORT`) — with `npm start`, the **UI** and **gateway** share this port; with `npm run dev`, the **UI** uses this port and the **gateway** uses `PORT + 1`

Full list of process environment variables: [Configuration — Process environment](CONFIGURATION.md#process-environment).

**Docker runtime** — bundled UI and MCP share the same port (`PORT`, default `3000`):

```bash
docker compose --env-file .env -f docker/docker-compose.yml up --build
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

When inbound OAuth is enabled for browser-based clients, `auth.oauth.allowedBrowserOrigins` must allow the browser `Origin` that opens the MCP connection. That field is separate from OAuth callback URLs: in embedded mode the client registers `redirect_uris` dynamically, while external issuers must be configured in the upstream IdP. For Claude remote MCP connectors, Anthropic currently documents `https://claude.ai/api/mcp/auth_callback` and recommends also allowing `https://claude.com/api/mcp/auth_callback`.

Invalid namespace or body returns **400** with error details.
Tool and downstream execution failures are returned as **HTTP 200** with a JSON-RPC `error` object in the body. Treat the JSON-RPC payload as the source of truth, not the HTTP status alone.

### Codex CLI

For Codex CLI, configure the MCP server URL plus a bearer token environment variable. Do not place a bare
`Authorization = "Bearer ..."` key inside the TOML server block, because Codex does not treat that as an HTTP header
for streamable HTTP MCP servers.

```toml
[mcp_servers.mcpr-gateway]
url = "http://127.0.0.1:3000/mcp/default"
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

If static files exist under `ui/dist` or `ui/build` (or `UI_STATIC_DIR`), the server redirects `/` to `/ui/`. That is the built/static deployment path. Build the UI once with:

```bash
npm run build:ui
```

See [Development](DEVELOPMENT.md#web-ui) for day-to-day UI work (`npm run dev` runs Vite + gateway together).

## Next steps

| Guide                             | What's in it                                                     |
| --------------------------------- | ---------------------------------------------------------------- |
| [Configuration](CONFIGURATION.md) | All `bootstrap.json` sections, env interpolation, two-tier model |
| [HTTP API](reference/HTTP-API.md) | Health, admin, debug routes — full endpoint reference            |
| [Deployment](DEPLOYMENT.md)       | Docker Compose, persistence, admin protection, TLS               |
| [Development](DEVELOPMENT.md)     | Scripts, project layout, test strategy, UI workflow              |
| [Architecture](ARCHITECTURE.md)   | Components, request flow, session lifecycle                      |
