# Deployment

## Docker image

The [Dockerfile](../docker/Dockerfile) is multi-stage:

1. Builds the Svelte UI into `ui/build` (published in the image as `ui/dist` beside the server).
2. Builds the TypeScript gateway to `dist/` via `npm run build:gateway` (UI is built in the previous stage only).
3. Runtime image: `node:24-alpine`, installs native build prerequisites (`python3`, `make`, `g++`) for modules such as `better-sqlite3`, runs `npm ci --omit=dev`, sets `CONFIG_PATH=/config`, and exposes **3000**.

Runtime requirement for `code` mode:

- use **Node 24 LTS**
- start Node with `--no-node-snapshot` when `isolated-vm` is enabled

For a non-Docker local runtime, the repository default is:

```bash
cp .env.example .env
npm ci
npm run build
npm start
```

`npm start` reads required variables from the process environment first and fills any missing ones from `.env` when that file exists. It refuses placeholder security values from the example file and serves the built UI plus MCP gateway on the same port.

Build from repository root:

```bash
npm run docker:build
# or: docker build -f docker/Dockerfile .
```

## Docker Compose

[docker/docker-compose.yml](../docker/docker-compose.yml) mounts:

- `../config` → `/config` (**read-only**)
- `../data` → `/app/data` for SQLite

Compose **variable interpolation** (`${ADMIN_TOKEN:?}`, `${PORT:-3000}`, etc.) reads from the host environment or an explicit env file. Run it from repo root with `docker compose --env-file .env -f docker/docker-compose.yml ...` or export the variables in your shell/CI first. Runtime `HOST` is set to `0.0.0.0` inside the service definition — a dev-only `HOST=127.0.0.1` in `.env` does not affect the container bind address.

Typical environment:

| Variable          | Example                 | Purpose                                                                                          |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `HOST`            | `0.0.0.0`               | Bind address inside container                                                                    |
| `LOG_LEVEL`       | `info`                  | Pino log level                                                                                   |
| `SESSION_BACKEND` | _(omit)_                | Default: SQLite-backed persistence (`DATABASE_PATH`)                                             |
| `SESSION_BACKEND` | `memory`                | In-process sessions only; admin config writes to `bootstrap.json`                                |
| `DATABASE_PATH`   | `/app/data/gateway.db`  | SQLite file when not using `memory`                                                              |
| `UI_STATIC_DIR`   | `/app/ui/dist`          | Ensures the UI is found in the image layout                                                      |
| `ADMIN_TOKEN`     | _(any non-empty value)_ | Enables admin protection for `/admin/*` when set (not the login password; use `GATEWAY_ADMIN_*`) |
| `GATEWAY_ADMIN_USER` | `admin` or custom | Admin username for `/admin/auth/login`; set an explicit value before publishing |
| `GATEWAY_ADMIN_PASSWORD` | _(non-empty secret)_ | Required when `ADMIN_TOKEN` is set; startup fails fast if omitted |
| `DOWNSTREAM_AUTH_ENCRYPTION_KEY` | `openssl rand -base64 32` | Required for managed downstream bearer/OAuth secrets; malformed values fail fast |

Run from repo root (provide required variables through `.env` or your shell — see [Minimum security variables](../README.md#minimum-security-variables)):

```bash
docker compose --env-file .env -f docker/docker-compose.yml up --build
```

For any real deployment, clients should authenticate with persisted client Bearer tokens (issued via the Access Control panel or present under `auth.staticKeys` in bootstrap).

By default the gateway uses **SQLite** for sessions, audit, config version history, and downstream auth rows (`DATABASE_PATH`, default `./data/gateway.db`). Set **`SESSION_BACKEND=memory`** only if you explicitly want **no** database file (ephemeral sessions; admin changes persist to `CONFIG_PATH/bootstrap.json` instead). The DB layer is wired through `IDbAdapter` / `SqliteAdapter` in [`src/db/`](../src/db/) for future alternative backends. See [`src/index.ts`](../src/index.ts).

## Admin API and production

Admin routes are **registered** when `debug.enabled` **or** `ADMIN_TOKEN` is set **or** `NODE_ENV !== 'production'`.

Implications:

- **Production** with `NODE_ENV=production`, debug off, and **no** `ADMIN_TOKEN` → **admin routes are not mounted** (safest default for a pure MCP edge).
- **Non-production** or debug or `ADMIN_TOKEN` set → admin routes are mounted.

When admin routes are mounted **and** `ADMIN_TOKEN` is **unset**, `requireAdminAuth` does not add middleware: **admin endpoints are not protected by the gateway**. Rely on network policy or set `ADMIN_TOKEN` and sign in via `/admin/auth/login` (cookie).

When `ADMIN_TOKEN` **is** set, admin users must complete `POST /admin/auth/login` with `GATEWAY_ADMIN_USER` / `GATEWAY_ADMIN_PASSWORD` and send the resulting `admin_session` cookie on further `/admin/*` requests. The gateway fails fast during startup if `ADMIN_TOKEN` is set without a non-empty `GATEWAY_ADMIN_PASSWORD`.

## Configuration file in containers

Compose uses `CONFIG_PATH=/config` and a read-only mount. Keep secrets out of git: use `${VAR}` placeholders in `bootstrap.json` and pass secrets via Compose environment (see [Configuration — Environment interpolation](CONFIGURATION.md#environment-interpolation)).

Typical production flow:

1. Copy `config/bootstrap.example.json` to `config/bootstrap.json` (or run `npm run setup -- --advanced`)
2. Set `ADMIN_TOKEN`, `GATEWAY_ADMIN_USER`, and `GATEWAY_ADMIN_PASSWORD` in your environment or platform secrets before starting the container
3. Create or manage client access tokens from the Access Control panel (or use `${...}` interpolation in `bootstrap.json` for bootstrap-only secrets)
4. Have MCP clients authenticate with `Authorization: Bearer <client-access-token>`

Bootstrap policy and auth still load from `CONFIG_PATH/bootstrap.json`. With SQLite, admin-managed config is stored in the DB; with `SESSION_BACKEND=memory`, the file must be writable for admin saves. A read-only config mount is fine for SQLite-only deployments if you do not rewrite `bootstrap.json` at runtime.

## TLS and reverse proxies

The gateway speaks HTTP only. Terminate TLS in your reverse proxy (nginx, Traefik, Caddy) and forward to the container port.

## MCP client compatibility

- JSON-RPC tool failures may still return **HTTP 200** with an `error` object in the body
- some MCP clients may execute requests successfully but fail to expose the returned `result` payload to the model
- when validating a deployment, keep a raw HTTP JSON-RPC check available in addition to client-native MCP testing

## Backups

With SQLite, copy the database file while the process is stopped or use a filesystem snapshot. Compose comment suggests e.g. `cp data/gateway.db data/gateway.db.bak`.

## First-time production checklist

- [ ] **Node.js 24 LTS** in the runtime environment
- [ ] `NODE_ENV=production` set — prevents admin routes from mounting without an explicit `ADMIN_TOKEN`
- [ ] `HOST=0.0.0.0` set — container needs to bind on all interfaces; `127.0.0.1` (default) won't work inside Docker
- [ ] `ADMIN_TOKEN` set to a non-empty, secret value — enables admin route protection
- [ ] `GATEWAY_ADMIN_USER` and `GATEWAY_ADMIN_PASSWORD` set — credentials for `/admin/auth/login`
- [ ] `DOWNSTREAM_AUTH_ENCRYPTION_KEY` set if using managed downstream credentials (base64-encoded 32-byte key)
- [ ] `docker compose --env-file .env -f docker/docker-compose.yml config` (from repo root) renders `ADMIN_TOKEN`, `GATEWAY_ADMIN_PASSWORD`, and port correctly — confirms variables are resolved
- [ ] `DATABASE_PATH` mapped to a persistent volume (`/app/data/gateway.db` in Compose default)
- [ ] Config volume (`/config`) mounted read-only — safe with SQLite-backed deployments
- [ ] TLS terminated by reverse proxy (nginx, Traefik, Caddy) before the container — gateway speaks HTTP only
- [ ] MCP clients configured with valid Bearer tokens issued via the Access Control panel (or `auth.staticKeys` in bootstrap for file-first setups)
- [ ] Backup strategy in place for `gateway.db` — copy while stopped or use filesystem snapshots
- [ ] `--no-node-snapshot` passed to Node when starting the gateway outside of Docker (Docker image and dev scripts handle this automatically)
