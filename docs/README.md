# MCPR Gateway — Documentation

Human-oriented guides for installing, configuring, operating, and developing the gateway. For machine-readable config details, the Zod schemas in [`src/config/schemas.ts`](../src/config/schemas.ts) are authoritative.

## Guides

| Guide                                 | Audience               | Contents                                                         |
| ------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| [Getting started](getting-started.md) | Operators, integrators | Dependencies, setup, MCP client flow, auth basics                |
| [Configuration](CONFIGURATION.md)     | Operators              | `bootstrap.json`, selector publication, `CONFIG_PATH`, SQLite, Web UI |
| [Architecture](architecture.md)       | Contributors           | Sessions, registry, selector, triggers, high-level flow          |
| [HTTP API](http-api.md)               | Integrators            | Health, MCP JSON-RPC, admin, debug, static UI                    |
| [Deployment](deployment.md)           | Operators              | Docker Compose, persistence, production hardening                |
| [Development](development.md)         | Contributors           | npm scripts, tests, building the Web UI                          |
| [../CHANGELOG.md](../CHANGELOG.md)    | Operators, adopters    | Current release notes, supported runtimes, publication caveats   |

## Repository map

| Path                    | Role                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| [`src/`](../src/)       | Gateway server (Fastify), MCP dispatch, registry, selector             |
| [`config/`](../config/) | Example `gateway*.example.json` files (real `bootstrap.json` is local) |
| [`ui/`](../ui/)         | Svelte admin UI (served under `/ui/` when built)                       |
| [`docker/`](../docker/) | `Dockerfile` and `docker-compose.yml`                                  |

## Config quick link

See [`config/README.md`](../config/README.md) for copy-paste examples and links back to [Configuration](CONFIGURATION.md).
