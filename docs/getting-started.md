# Getting started

## Requirements

- **Node.js** ≥ 20 ([`package.json`](../package.json) `engines`)
- For Docker: Docker Engine and Compose v2

## Install and configure

```bash
git clone <repository-url>
cd mcp-session-gateway
npm ci
npm run setup
```

[`npm run setup`](../scripts/setup.ts) interactively copies a profile into `config/bootstrap.json`. Example sources live in [`config/`](../config/) (`bootstrap.example.json`). The current example is pretty minimal. It is recommended for testing and reproducible instances only.

For anything beyond local experimentation, use **`static_key`** auth (the only supported bootstrap mode). Add client access tokens in the **admin UI** (Access Control) after setting `ADMIN_TOKEN` and signing in with `GATEWAY_ADMIN_USER` / `GATEWAY_ADMIN_PASSWORD`, or define entries under `auth.staticKeys` in `bootstrap.json` (optionally using `${VAR}` placeholders — missing env vars cause startup failure).

If you skip `setup`, you can copy an example manually:

```bash
cp config/bootstrap.example.json config/bootstrap.json
# Then: add tokens via the Web UI, or edit auth.staticKeys in bootstrap.json
```

When `bootstrap.json` is missing, the process still starts with built-in defaults and **no downstream servers** (see [Configuration](CONFIGURATION.md#missing-file)).

## Run the gateway

```bash
npm run dev
```

Defaults:

- **Host:** `127.0.0.1` — loopback only; set `HOST=0.0.0.0` for Docker or LAN exposure
- **Port:** `3000` (`PORT`)

Full list of process environment variables: [Configuration — Process environment](CONFIGURATION.md#process-environment).

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

### Codex CLI

For Codex CLI, configure the MCP server URL plus a bearer token environment variable. Do not place a bare
`Authorization = "Bearer ..."` key inside the TOML server block, because Codex does not treat that as an HTTP header
for streamable HTTP MCP servers.

```toml
[mcp_servers.mcp-session-gateway]
url = "http://127.0.0.1:3000/mcp/all"
bearer_token_env_var = "MCP_SESSION_GATEWAY_TOKEN"
```

```bash
export MCP_SESSION_GATEWAY_TOKEN=<client-access-token>
```

If Codex sends `initialize` without the bearer token, the handshake often fails with a response decoding error before
any tools are listed.

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

See [Development](development.md#web-ui) for day-to-day UI work.

## Next steps

- [Configuration](CONFIGURATION.md) — all `bootstrap.json` sections and `${VAR}` interpolation
- [HTTP API](http-api.md) — health, admin, debug routes
- [Deployment](deployment.md) — Compose, persistence, admin protection (`ADMIN_TOKEN` / `GATEWAY_ADMIN_*`), and `NODE_ENV`
