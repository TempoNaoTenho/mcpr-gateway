# Quick Start

**Prerequisites:** Node.js 22 or 24 LTS

Release readiness snapshot:

- `code` mode is validated on **Node 22/24 LTS** with `isolated-vm`
- **Node 25** and other odd-numbered releases are not supported
- MCP/JSON-RPC tool failures are returned as **HTTP 200** with an `error` object in the response body
- Some MCP clients may execute successfully but fail to show the returned `result` payload to the model; verify with raw HTTP if needed

```bash
git clone <repository-url>
cd mcpr-gateway
npm ci
npm run setup    # optional: .env checks, env prompts, optional bootstrap.json (advanced)
```

### Connecting your AI client (HTTP)

The gateway serves MCP over **HTTP**. Downstream MCP servers you configure may still use **stdio** or **HTTP/streamable-HTTP** in `bootstrap.json` / runtime config.

| Step         | What to do                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run          | Start the gateway; it listens on `HOST` / `PORT` (defaults `127.0.0.1` / `3000`).                                                                                                                                           |
| MCP endpoint | `POST /mcp/<namespace>` for JSON-RPC. Streamable HTTP clients can also use `GET /mcp/<namespace>` for SSE. The path segment must match a configured namespace (many setups use `default`).                                  |
| Auth         | Send `Authorization: Bearer <token>` on MCP requests. Tokens are issued via the admin UI / admin API and map through `static_key` auth (same as [docs/http-api.md](docs/http-api.md)).                                      |
| Session      | After `initialize`, read `Mcp-Session-Id` from the **response** headers and send it on later `tools/list` and `tools/call` requests. Optional `Mcp-Tools-Changed` on responses indicates the tool catalog may have changed. |
| Admin        | WebUI (`/ui/` after `npm run build` or `npm run build:ui`), `/admin/*`, and `/health` run in the **same** process.                                                                                                          |

Full route list, CORS, and notification behavior: [docs/http-api.md](docs/http-api.md).

### `npm run setup` vs `npm run dev`

| Script              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`npm run setup`** | Optional **first-time helper**: Node `engines` check, `.env` from [`.env.example`](.env.example) if missing, port checks for full-stack dev, SQLite path info, interactive `.env` prompts, and **optional** `config/bootstrap.json` (advanced / GitOps). Does not install dependencies or start servers. Full bootstrap reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md) and [config/README.md](config/README.md). |
| **`npm run dev`**   | **Default local stack**: gateway (`npm run dev:gateway` on `HOST` / **`PORT + 1`**) plus SvelteKit **Vite** on **`PORT`** ([`scripts/dev-all.mjs`](scripts/dev-all.mjs)). Sets `GATEWAY_PROXY_TARGET` so the browser uses one origin for `/ui`, `/admin`, `/mcp`, `/health`.                                                                                                                                                |

`npm run dev:all` is the same as `npm run dev`. `bootstrap.json` is **not** required: without it the gateway starts with built-in defaults and an empty server list (Web UI + SQLite hold runtime config after first start).

### Run commands

**Full-stack local dev (default)**

```bash
npm run dev
```

Open the URL Vite prints (typically `http://127.0.0.1:3000`); the gateway listens on **the next port** (typically `3001`).

**API only (hot-reload gateway)**

```bash
npm run dev:gateway   # single process on HOST/PORT (default http://127.0.0.1:3000)
```

Runtime requirement for code mode stability:

- use Node **22** or **24 LTS**
- avoid odd-numbered Node releases such as **25**
- the gateway must start with `--no-node-snapshot` for `isolated-vm`; `npm run dev` and `npm run dev:gateway` now set this automatically

Client compatibility note:

- Cursor and similar MCP clients may hide the `result` body from the model even when the gateway returns `HTTP 200` with a valid JSON-RPC `result`
- when validating the gateway itself, prefer checking the raw HTTP JSON-RPC body before treating that as a server-side failure

The admin WebUI at `/ui/` is served only if static files exist: run **`npm run build`** (UI + gateway) or **`npm run build:ui`** alone (output under `ui/build`; the server also accepts `ui/dist` or `UI_STATIC_DIR`).

**Docker** (optional `npm run setup` for `.env` / bootstrap):

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

| Variable                         | Default             | Purpose                                                                                     |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| `HOST`                           | `127.0.0.1`         | Bind address (`0.0.0.0` for Docker)                                                         |
| `PORT`                           | `3000`              | HTTP port                                                                                   |
| `CONFIG_PATH`                    | `./config`          | Directory containing `bootstrap.json`                                                       |
| `DATABASE_PATH`                  | `./data/gateway.db` | SQLite file path                                                                            |
| `SESSION_BACKEND`                | _(unset = SQLite)_  | Set to `memory` for ephemeral sessions                                                      |
| `ADMIN_TOKEN`                    | _(unset)_           | When set (any non-empty value), `/admin/*` requires login (cookie), not the password itself |
| `GATEWAY_ADMIN_USER`             | `mcpgateway`        | Admin UI login username when `ADMIN_TOKEN` is set                                           |
| `GATEWAY_ADMIN_PASSWORD`         | _(unset)_           | When set, required with username; when unset, username-only login                           |
| `DOWNSTREAM_AUTH_ENCRYPTION_KEY` | _(unset)_           | Base64 32-byte key for encrypted downstream secrets                                         |
| `LOG_LEVEL`                      | `info`              | Pino log level                                                                              |
| `AUDIT_RETENTION_DAYS`           | `90`                | Default audit log retention                                                                 |

Bootstrap `auth` is only `{"mode": "static_key"}` (see [`config/bootstrap.example.json`](config/bootstrap.example.json)); **client Bearer tokens are created in the admin WebUI / API**, not listed in `bootstrap.json`. Other bootstrap strings may still use `${VAR_NAME}` environment interpolation where the schema allows it.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full schema reference.
