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

Recommendation: use `npm run setup` and choose the profile that matches your environment. Auth is always **`static_key`**; use the Access Control panel (or `auth.staticKeys` in `bootstrap.json`) for client bearer tokens.

By default the HTTP server binds to `127.0.0.1`, which keeps development local to the host machine. Set `HOST=0.0.0.0` only when you intentionally need Docker or remote network exposure.

### Profiles (examples)

| File                     | Use case                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `bootstrap.example.json` | Template copied to `bootstrap.json` by `npm run setup`; `static_key` auth, minimal policies    |

### Docker

From the **repository root**:

```bash
npm run setup
npm run docker:up   # compose mounts ./config → /config, CONFIG_PATH=/config
```

The compose setup pins `HOST=0.0.0.0` and `UI_STATIC_DIR=/app/ui/dist` so the container serves the built WebUI correctly on `http://localhost:3000`.

### Manual copy

```bash
cp config/bootstrap.example.json config/bootstrap.json
# Add client tokens via the Web UI or edit auth.staticKeys; optional ${VAR} in JSON requires those env vars at startup
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
