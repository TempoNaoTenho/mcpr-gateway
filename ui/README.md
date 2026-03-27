# Admin Web UI

Svelte-based admin interface for MCPR Gateway. It is served by the gateway at **`/ui/`** when static assets exist (see [`src/gateway/routes/ui.ts`](../src/gateway/routes/ui.ts)).

## Prerequisites

- Node.js ≥ 20 (same as the root project)

## Commands

Run from this directory (`ui/`) or via npm prefix:

```bash
npm ci
npm run dev          # Vite alone (default port 5173; or use repo root `npm run dev` for integrated PORT)
npm run build        # Output: ui/build (used by root `npm run build:ui` and Docker)
npm run preview      # Preview production build
```

Full-stack local development from the **repository root**:

```bash
npm run dev          # Vite on PORT + gateway on PORT+1 (see root package.json; `dev:all` is an alias)
```

## Integration with the gateway

- The gateway looks for a built UI in `UI_STATIC_DIR`, then `ui/dist`, then **`ui/build`** relative to the process working directory.
- Root script `npm run build:ui` runs `npm run build` here; `npm run build` at the repo root runs UI then the gateway bundle (`build:all` is an alias).
- HTTP: [`GET /`](../docs/http-api.md) redirects to `/ui/`; static files are mounted under `/ui/`.

## API usage

The UI talks to the same host as the gateway, using **`/admin/*`** JSON endpoints. When `ADMIN_TOKEN` is set on the server, sign in with the configured admin username and password (session cookie). See [docs/http-api.md](../docs/http-api.md#admin-api).

## Project stack

This UI was created with the Svelte CLI (`sv`). Application-specific behavior lives under `src/`; replace generic upstream README sections with this file as the source of truth for gateway contributors.
