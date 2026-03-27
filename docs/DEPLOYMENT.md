# Deployment

## Docker image

The [Dockerfile](../docker/Dockerfile) is multi-stage:

1. Builds the Svelte UI into `ui/build` (published in the image as `ui/dist` beside the server).
2. Builds the TypeScript gateway to `dist/` via `npm run build:gateway` (UI is built in the previous stage only).
3. Runtime image: `node:24-alpine`, `npm ci --omit=dev`, `CONFIG_PATH=/config`, exposes **3000**.

Runtime requirement for `code` mode:

- use **Node 22 or 24 LTS**
- avoid odd-numbered releases such as **25**
- start Node with `--no-node-snapshot` when `isolated-vm` is enabled

Build from repository root:

```bash
npm run docker:build
# or: docker build -f docker/Dockerfile .
```

## Docker Compose

[docker/docker-compose.yml](../docker/docker-compose.yml) mounts:

- `../config` → `/config` (**read-only**)
- `../data` → `/app/data` for SQLite

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

Run from repo root (`npm run setup` is optional; compose can mount an empty config dir if you rely on defaults only):

```bash
npm run docker:up
```

For any real deployment, clients should authenticate with persisted client Bearer tokens (issued via the Access Control panel or present under `auth.staticKeys` in bootstrap).

By default the gateway uses **SQLite** for sessions, audit, config version history, and downstream auth rows (`DATABASE_PATH`, default `./data/gateway.db`). Set **`SESSION_BACKEND=memory`** only if you explicitly want **no** database file (ephemeral sessions; admin changes persist to `CONFIG_PATH/bootstrap.json` instead). The DB layer is wired through `IDbAdapter` / `SqliteAdapter` in [`src/db/`](../src/db/) for future alternative backends. See [`src/index.ts`](../src/index.ts).

## Admin API and production

Admin routes are **registered** when `debug.enabled` **or** `ADMIN_TOKEN` is set **or** `NODE_ENV !== 'production'`.

Implications:

- **Production** with `NODE_ENV=production`, debug off, and **no** `ADMIN_TOKEN` → **admin routes are not mounted** (safest default for a pure MCP edge).
- **Non-production** or debug or `ADMIN_TOKEN` set → admin routes are mounted.

When admin routes are mounted **and** `ADMIN_TOKEN` is **unset**, `requireAdminAuth` does not add middleware: **admin endpoints are not protected by the gateway**. Rely on network policy or set `ADMIN_TOKEN` and sign in via `/admin/auth/login` (cookie).

When `ADMIN_TOKEN` **is** set, admin users must complete `POST /admin/auth/login` with `GATEWAY_ADMIN_USER` / `GATEWAY_ADMIN_PASSWORD` and send the resulting `admin_session` cookie on further `/admin/*` requests.

## Configuration file in containers

Compose uses `CONFIG_PATH=/config` and a read-only mount. Keep secrets out of git: use `${VAR}` placeholders in `bootstrap.json` and pass secrets via Compose environment (see [Configuration — Environment interpolation](CONFIGURATION.md#environment-interpolation)).

Typical production flow:

1. Copy `config/bootstrap.example.json` to `config/bootstrap.json` (or run `npm run setup`)
2. Set `ADMIN_TOKEN` (any non-empty value) in the container environment to require admin login, and set `GATEWAY_ADMIN_USER` / `GATEWAY_ADMIN_PASSWORD` as needed
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

- [ ] **Node.js 22 or 24 LTS** in the runtime environment — not Node 25 or odd-numbered releases
- [ ] `NODE_ENV=production` set — prevents admin routes from mounting without an explicit `ADMIN_TOKEN`
- [ ] `HOST=0.0.0.0` set — container needs to bind on all interfaces; `127.0.0.1` (default) won't work inside Docker
- [ ] `ADMIN_TOKEN` set to a non-empty, secret value — enables admin route protection
- [ ] `GATEWAY_ADMIN_USER` and `GATEWAY_ADMIN_PASSWORD` set — credentials for `/admin/auth/login`
- [ ] `DOWNSTREAM_AUTH_ENCRYPTION_KEY` set if using managed downstream credentials (base64-encoded 32-byte key)
- [ ] `DATABASE_PATH` mapped to a persistent volume (`/app/data/gateway.db` in Compose default)
- [ ] Config volume (`/config`) mounted read-only — safe with SQLite-backed deployments
- [ ] TLS terminated by reverse proxy (nginx, Traefik, Caddy) before the container — gateway speaks HTTP only
- [ ] MCP clients configured with valid Bearer tokens issued via the Access Control panel (or `auth.staticKeys` in bootstrap for file-first setups)
- [ ] Backup strategy in place for `gateway.db` — copy while stopped or use filesystem snapshots
- [ ] `--no-node-snapshot` passed to Node when starting the gateway outside of Docker (Docker image and dev scripts handle this automatically)
