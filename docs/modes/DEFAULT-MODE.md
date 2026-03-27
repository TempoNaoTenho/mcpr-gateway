# Default Mode

## Overview

Default mode exposes every enabled downstream tool in the namespace directly to the MCP client — no meta-tools, no search layer, full transparency. What the model receives in `tools/list` is the real tool catalog filtered by namespace membership and tool enabled status.

This is the simplest operating mode: the gateway acts as a transparent aggregator and the model selects tools by name from the full list.

## When to use Default Mode

- When the total downstream tool count is **small** and fits comfortably in the model's context window
- When you want **maximum transparency** — the model sees exactly what is available, no indirection
- When downstream tools have **distinct, non-overlapping names** and the model can select them directly
- When **debugging or testing** downstream tools — zero gateway indirection makes failures easy to attribute
- For **personal namespaces** with a curated, small set of tools (e.g. `/mcp/personal`)
- When the MCP client itself handles tool discovery (e.g. Claude Desktop with a small server set)

## How tools are selected

Each `tools/list` call returns all tools that satisfy:

1. **Namespace membership** — the tool's server has the namespace in its `namespaces` field
2. **Enabled status** — the server is enabled and the tool is not individually disabled
3. **Health status** — servers flagged unhealthy by the registry health monitor may be penalized or excluded depending on `selector.healthPenalty` config

Tool publication rules (`selector.publication`) still apply: description/schema compression, sanitization, and max-length limits are honored if configured. See [Configuration — Selector publication](../CONFIGURATION.md#selector-publication).

## Tool window

The `tools/list` response is the **full namespace catalog** — no ranking, no BM25, no discovery step. The trigger engine can refresh the window after tool calls if configured (`selector.triggers`), but the refresh is a re-fetch of the same full catalog.

Each session has its own window snapshot taken at `initialize`. If a downstream server becomes unavailable mid-session, the trigger engine may update the window on the next `tools/list` call.

## Namespace isolation

Every namespace has its own tool pool:

- `/mcp/dev` and `/mcp/personal` can each run in default mode but see **completely different downstream tools**
- Roles control which bearer tokens may access which namespace (set under `roles` in config)
- A server can appear in multiple namespaces — its tools appear in each namespace's pool independently

## Configuration

Set `mode` to `"default"` in the namespace config block, or **omit it** — default is the default:

```json
{
  "namespaces": {
    "personal": {
      "mode": "default",
      "allowedRoles": ["personal-user"]
    }
  }
}
```

No extra selector-specific config is required. The global `selector.publication` rules apply if present.

## Limitations

- **Does not scale to large tool catalogs** — the full list is sent to the model on every `tools/list`; large catalogs consume significant context window budget and may exceed model limits
- **No discovery layer** — the model must select from the complete list presented; there is no search or ranking to surface the most relevant tools
- **No batch execution** — each tool call is a separate `tools/call` round trip (use [Code Mode](CODE-MODE.md) for programmatic batching)

## See Also

- [Compat Mode](COMPAT-MODE.md) — two meta-tools for large catalogs; BM25-backed discovery
- [Code Mode](CODE-MODE.md) — JS sandbox with programmatic tool discovery and batch execution
- [Configuration](../CONFIGURATION.md) — namespace config, selector publication, resilience
- [Getting Started](../GETTING-STARTED.md#mcp-over-http) — namespace URL paths (`/mcp/:namespace`)
