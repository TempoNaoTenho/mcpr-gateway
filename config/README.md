# Configuration (`config/`)

The gateway uses a **bootstrap file**: `bootstrap.json` in this directory (or under `CONFIG_PATH`). The real file is gitignored; versioned **examples** use the `*.example.json` suffix.

**Important:** `bootstrap.json` is only used for initial setup. After first start with SQLite, all runtime configuration is managed through the admin panel and stored in the database. See [docs/CONFIGURATION.md](../docs/CONFIGURATION.md) for the full architecture.

**Documentation hub:** [docs/README.md](../docs/README.md) — guides and navigation.

**Full reference:** [docs/CONFIGURATION.md](../docs/CONFIGURATION.md) (sections, schemas, env interpolation, SQLite/UI, migration from YAML).

## Quick start

```bash
npm run setup   # interactive: choose profile → writes config/bootstrap.json
npm run dev
```

Recommendation: use the production profile unless you are intentionally doing local-only development. `mock_dev` is convenient for testing, but `static_key` is the correct path for hosted or shared use.

By default the HTTP server binds to `127.0.0.1`, which keeps development local to the host machine. Set `HOST=0.0.0.0` only when you intentionally need Docker or remote network exposure.

### Profiles (examples)

| File                              | Use case                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `gateway.production.example.json` | Recommended for hosted/shared use: `static_key`; example uses optional `${GATEWAY_API_KEY}` or use UI for tokens |
| `gateway.local.example.json`      | Local-only development: `mock_dev` auth, debug-friendly limits                                                   |
| `gateway.example.json`            | Full sample including a downstream server + static placeholder keys                                              |

### Docker

From the **repository root**:

```bash
npm run setup
npm run docker:up   # compose mounts ./config → /config, CONFIG_PATH=/config
```

The compose setup pins `HOST=0.0.0.0` and `UI_STATIC_DIR=/app/ui/dist` so the container serves the built WebUI correctly on `http://localhost:3000`.

### Manual copy

```bash
cp config/gateway.production.example.json config/bootstrap.json
# If the file still contains ${GATEWAY_API_KEY}, export it before start, or replace that key in JSON / add tokens via admin UI
```

### Environment interpolation

String values may contain `${VAR_NAME}` (uppercase, underscores). Missing variables cause startup failure. See [docs/CONFIGURATION.md](../docs/CONFIGURATION.md).

### Process environment

- `HOST` controls which address Fastify binds to. Default: `127.0.0.1` for secure local development; use `0.0.0.0` for Docker or intentional remote exposure.
- `PORT` controls the HTTP port. Default: `3000`.
- `UI_STATIC_DIR` optionally overrides where the built WebUI is served from. When omitted, the gateway looks for `ui/dist` and then `ui/build` under the current working directory.

### Schemas (code)

- Full file: `GatewayConfigFileSchema` in [`src/config/schemas.ts`](../src/config/schemas.ts)
- Each server: `DownstreamServerSchema` in [`src/types/server.ts`](../src/types/server.ts)

### Cross-section checks

At startup: every `servers[].namespace` and every `starterPacks` key must exist under `namespaces`. Unknown `allowedRoles` entries log a warning.
