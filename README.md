# MCP Session Gateway

Self-hosted **Model Context Protocol (MCP) gateway** that exposes a filtered, session-scoped tool window to clients. Downstream MCP servers are registered in config; the gateway selects a small, policy-bound subset of tools per session instead of advertising the full catalog.

## Features

- **Per-session tool windows** — cold start from starter packs and policy, then refresh via triggers
- **Namespaces and roles** — policy in `bootstrap.json` (and optionally the admin UI when using SQLite)
- **HTTP MCP edge** — JSON-RPC over `POST /mcp/:namespace` with `Mcp-Session-Id`
- **Optional Web UI** — admin dashboard and config management at `/ui/` when the UI is built
- **SQLite by default** — sessions, audit, config versioning, downstream auth (`DATABASE_PATH`, default `./data/gateway.db`); optional **`SESSION_BACKEND=memory`** for no on-disk DB (see [docs/CONFIGURATION.md](docs/CONFIGURATION.md#config-persistence))

## Documentation

| Doc                                                | Description                                         |
| -------------------------------------------------- | --------------------------------------------------- |
| [docs/README.md](docs/README.md)                   | Documentation index                                 |
| [docs/getting-started.md](docs/getting-started.md) | Install, config, first run                          |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md)     | `bootstrap.json`, env interpolation, SQLite vs file |
| [docs/architecture.md](docs/architecture.md)       | Concepts and request flow                           |
| [docs/http-api.md](docs/http-api.md)               | HTTP routes reference                               |
| [docs/deployment.md](docs/deployment.md)           | Docker, environment, security notes                 |
| [docs/development.md](docs/development.md)         | Scripts, tests, UI development                      |
| [config/README.md](config/README.md)               | Config directory quick reference                    |
| [SECURITY.md](SECURITY.md)                         | Security policy and vulnerability reporting         |

## Quick start

Prerequisites: **Node.js ≥ 20**.

```bash
npm ci
npm run setup    # interactive: writes config/bootstrap.json
npm run dev      # http://127.0.0.1:3000 by default
```

- MCP endpoint: `POST /mcp/<namespace>` (see [docs/getting-started.md](docs/getting-started.md)).
- With a built UI: open `http://127.0.0.1:3000/` (redirects to `/ui/`).

For **UI-managed downstream credentials** (bearer secret / OAuth persisted in the DB), set `DOWNSTREAM_AUTH_ENCRYPTION_KEY` (base64-encoded 32-byte key, e.g. `openssl rand -base64 32`) and use `ADMIN_TOKEN` to protect `/admin/*`. See [.env.example](.env.example), [docs/CONFIGURATION.md](docs/CONFIGURATION.md#managed-downstream-credentials), and [docs/deployment.md](docs/deployment.md).

Docker (from repo root, after `npm run setup`):

```bash
npm run docker:up
```

## License

MIT — see [package.json](package.json).
