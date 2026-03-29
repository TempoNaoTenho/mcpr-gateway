# Compat Mode

## Overview

Compat mode replaces the entire tool catalog with **three gateway tools**: `gateway_search_tools`, `gateway_call_tool`, and `gateway_list_servers`. Instead of receiving a full tool list, the model discovers and calls tools on demand through natural-language search. The client sees only these gateway tools regardless of how many downstream servers and tools are registered.

This keeps token usage predictable and low even when the total downstream catalog grows into the hundreds.

## When to use Compat Mode

- When the total downstream tool catalog is **large** (dozens or hundreds of tools across servers)
- When the model's **context window is a bottleneck** — compat mode has a small fixed gateway-tool overhead
- When tool discovery should happen **dynamically per request** rather than being pre-loaded
- When upstream MCP clients cannot handle large `tools/list` payloads
- When tool relevance varies significantly per task — BM25 surfaces contextually appropriate results

## Exposed Tools

### `gateway_search_tools`

Performs BM25 lexical search over all enabled tools in the namespace and returns a ranked list of candidates.

```typescript
gateway_search_tools({
  query: string,          // natural-language or keyword query
  serverId?: string,      // optional: restrict search to a specific downstream server
  limit?: number          // optional: max results to return (default 5)
}) → Array<{
  name: string,          // tool name as registered by the downstream server
  description: string,   // public description (may be compressed per publication rules)
  serverId: string,      // downstream server ID for use in gateway_call_tool
  handle: string         // stable handle for this tool in the current session
}>
```

Only returns tools from **enabled, healthy** downstream servers. Results are ranked by BM25 score; unhealthy servers are penalized before exclusion.

### `gateway_list_servers`

Returns exact downstream server IDs currently available in the namespace.

```typescript
gateway_list_servers({}) → Array<{
  serverId: string
}>
```

Use this only when the relevant downstream integration is unclear. If the task already names the target integration, go straight to `gateway_search_tools({ query, serverId })`.

### `gateway_call_tool`

Routes a tool call to the correct downstream server. Handles auth, error normalization, and resilience (timeouts, rate limits, concurrency).

```typescript
gateway_call_tool({
  name: string,           // tool name from gateway_search_tools result
  serverId: string,       // downstream server ID from gateway_search_tools result
  arguments: Record<string, unknown>  // tool arguments per downstream schema
}) → tool result (MCP content[])
```

Returns the raw tool result from downstream. JSON-RPC tool failures come back as `HTTP 200` with an `error` object — check the JSON-RPC payload, not the HTTP status.

## Typical Model Flow

1. Receive a task requiring tool use
2. If the target integration is unclear, call `gateway_list_servers({})` to confirm exact `serverId` values
3. Call `gateway_search_tools({ query, serverId? })` → get candidate tools ranked by relevance
4. Inspect results: pick the best match by name and description; optionally refine the search
5. Call `gateway_call_tool({ name, serverId, arguments })` with the selected tool
6. Parse the result and continue with the next step of the task

```
# Example:

1. gateway_list_servers({})
   → [{ serverId: "filesystem" }, { serverId: "github" }]

2. gateway_search_tools({ query: "list files in repository", serverId: "filesystem" })
   → [{ name: "fs_list_dir", serverId: "filesystem", ... }, ...]

3. gateway_call_tool({
     name: "fs_list_dir",
     serverId: "filesystem",
     arguments: { path: "/" }
   })
   → [{ type: "text", text: "bin/  config/  docs/  src/  ..." }]
```

## Configuration

Enable compat mode per namespace in your bootstrap config:

```json
{
  "namespaces": {
    "dev": {
      "mode": "compat",
      "allowedRoles": ["dev-user"]
    }
  }
}
```

Relevant config sections:

- **`selector.bm25`** — controls BM25 ranking parameters and default `k` (result count)
- **`selector.publication`** — description/schema compression applied before BM25 indexing
- **`resilience`** — rate limiting and per-downstream concurrency limits apply to `gateway_call_tool` calls
- **`session.handleTtlSeconds`** — handles returned by `gateway_search_tools` expire with the session

See [Configuration](../CONFIGURATION.md#selector) for full selector options.

## Limitations

- **No batch execution** — `gateway_call_tool` runs one tool at a time; use [Code Mode](CODE-MODE.md) for parallel batch calls
- **Lexical search only** — BM25 is keyword-based; semantic/embedding search is not yet supported
- **Relevance depends on description quality** — poorly described downstream tools rank low and may not surface in results
- **Handle lifetime** — search handles are scoped to the current session; do not persist them across sessions

## See Also

- [Code Mode](CODE-MODE.md) — JS sandbox for programmatic multi-tool orchestration and batching
- [Default Mode](DEFAULT-MODE.md) — exposes all tools directly; no discovery layer
- [Configuration](../CONFIGURATION.md#selector) — BM25 and selector publication settings
