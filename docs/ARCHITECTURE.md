# Architecture

High-level view of how the gateway processes MCP traffic and keeps sessions. For exact HTTP paths see [HTTP API](reference/HTTP-API.md); for config keys see [Configuration](CONFIGURATION.md).

## Main components

| Component                                                                                                   | Responsibility                                                   |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **HTTP edge** ([`src/gateway/`](../src/gateway/))                                                           | Fastify server, route registration, JSON-RPC dispatch            |
| **Downstream registry** ([`src/registry/`](../src/registry/))                                               | Connections to MCP servers (stdio/HTTP), tool lists, health      |
| **Session store** ([`src/session/`](../src/session/), SQLite repos)                                         | Session state, tool window, selector traces                      |
| **Policy** ([`src/policy/`](../src/policy/))                                                                | Whether a principal may use a namespace and mode                 |
| **Toolcards & candidate pool** ([`src/toolcard/`](../src/toolcard/), [`src/candidate/`](../src/candidate/)) | Normalized tool metadata and filtered candidates for selection   |
| **Selector engine** ([`src/selector/`](../src/selector/))                                                   | BM25/lexical ranking and penalties to build the visible tool set |
| **Trigger engine** ([`src/trigger/`](../src/trigger/))                                                      | Decides when to refresh the tool window after tool calls         |
| **Execution router** ([`src/router/router.ts`](../src/router/router.ts))                                    | Routes `tools/call` to the right downstream server               |
| **Resilience** ([`src/resilience/`](../src/resilience/))                                                    | Rate limiting and timeouts (config-driven)                       |
| **Observability** ([`src/observability/`](../src/observability/))                                           | Structured logs and optional SQLite audit                        |

## Request flow (MCP)

```sequenceDiagram
  participant Client
  participant Gateway as Gateway_HTTP
  participant Policy
  participant Registry as DownstreamRegistry
  participant Store as SessionStore
  participant Selector as SelectorEngine

  Client->>Gateway: POST /mcp/ns initialize
  Gateway->>Policy: resolve identity + namespace + mode
  Policy-->>Gateway: allow + namespace policy
  Gateway->>Registry: tools for namespace
  Registry-->>Gateway: toolcards
  Gateway->>Selector: bootstrap window / cold start
  Selector-->>Gateway: selected tools
  Gateway->>Store: persist session
  Gateway-->>Client: result + Mcp-Session-Id

  Client->>Gateway: tools/list (session header)
  Gateway->>Store: load session
  Gateway-->>Client: tool window

  Client->>Gateway: tools/call
  Gateway->>Store: load session
  Gateway->>Gateway: route + triggers refresh if configured
```

## Session lifecycle

1. **`initialize`** — Authenticates (Bearer), checks policy, creates a session id, builds the initial tool window (bootstrap / starter pack), stores session state.
2. **`tools/list`** — Reads the session and returns the current window (may change after triggers).
3. **`tools/call`** — Executes on a downstream server; the trigger engine may schedule a selector refresh for subsequent `tools/list` calls.

Session TTL and cleanup interval come from `session` in config ([`GatewayConfigFileSchema`](../src/config/schemas.ts)).

## Configuration split

- **Bootstrap file** `CONFIG_PATH/bootstrap.json` — Always loaded; **`auth` always originates here** (or defaults when the file is absent). After first startup with SQLite, changes to this file are ignored (except for `auth` which is always merged from the file).
- **Runtime / admin slice** — When the admin UI is available, servers and policy sections (except `auth`) can be updated via the admin API / UI. Persistence goes to SQLite when configured, otherwise it rewrites `CONFIG_PATH/bootstrap.json`. See [Configuration — Config persistence](CONFIGURATION.md#config-persistence).

## Tool metadata: toolcards vs client-facing projection

Downstream tool definitions are normalized into **toolcards** (sanitized descriptions, stable names) for ranking and storage. MCP clients do not always see that raw toolcard text: responses apply **`selector.publication`** rules to produce a **public** description and input schema (optional conservative compression and optional max length). Toolcard sanitization and publication compression are separate stages; details and defaults are documented under [Configuration — Selector publication](CONFIGURATION.md#selector-publication).

## Namespaces and downstream servers

Each downstream server entry carries a `namespace`. The gateway groups tools by namespace for candidate pools and routing. Cross-references in config (`starterPacks` keys, `servers[].namespace`, `roles`) are validated at startup (warnings or errors per loader logic in [`src/config/loader.ts`](../src/config/loader.ts)).

## Operating modes

Each namespace runs in one of three modes, configured under `namespaces[].mode`:

| Mode | Exposed tools | Best for |
| ---- | ------------- | -------- |
| **Default** | All enabled downstream tools filtered by namespace | Small tool sets, maximum transparency |
| **Compat** | Two meta-tools: `gateway_search_tools` + `gateway_call_tool` | Large catalogs, context-window efficiency |
| **Code** | Two tools: `gateway_run_code` + `gateway_help` | Programmatic multi-tool orchestration in a JS sandbox |

- [Default Mode](modes/DEFAULT-MODE.md) — full tool catalog, no indirection
- [Compat Mode](modes/COMPAT-MODE.md) — BM25-backed discovery via meta-tools
- [Code Mode](modes/CODE-MODE.md) — `isolated-vm` sandbox with built-in MCP runtime API

## Resilience layer

Sits between the execution router and downstream servers. Configured under [`resilience`](CONFIGURATION.md) in the config file:

- **Rate limiting** — per-client request throttling via `@fastify/rate-limit`
- **Concurrency limits** — per-downstream server cap on simultaneous in-flight tool calls
- **Timeouts** — per-request deadline enforcement for downstream HTTP calls
- **Health-aware ranking** — unhealthy servers are penalized in selector scoring (compat/code modes); degraded servers surface lower in results before being fully excluded
