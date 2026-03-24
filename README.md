# Codeuctor MCP Gateway - MCP Managment and Sandboxed Code Execution

Self-hosted **Model Context Protocol (MCP) gateway** that exposes a filtered, session-scoped tool window to clients. Downstream MCP servers are registered in config; the gateway provide three modes to choose from: Default, Compat and Code that can increase effectiveness and reduce the context usage by the client on certain scenarios.

## Features

## Modes

- **Code**: Inspired by [Cloudflare: Code Mode MCP](https://blog.cloudflare.com/code-mode-mcp/), [Anthropic: Code Execution Article](https://www.anthropic.com/engineering/code-execution-with-mcp?_hsmi=390282592)

- **Default**: Default mode exposes the enabled downstream tools directly that you can filter according to namespaces, role e access modes. E.g: "mcp/dev" > Dev tools only with
- **Compat**: Compat mode exposes 02 tools only `gateway_search_tools` and `gateway_call_tool` that can be used to discover and call any tool that is available to the client. This is good when you want a lot of tools together inside a namespace but you want to minimize the context usage.

## Installation

### Local

- production
- development

### Docker Self-hosted

## Security

## Audit

## Compatibility

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
