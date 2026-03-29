# Code Mode

## Runtime requirements

- **Node.js 24 LTS**
- Gateway must start with `--no-node-snapshot` for `isolated-vm` stability — `npm start`, `npm run dev`, and `npm run dev:gateway` set this automatically; if starting `node dist/index.js` directly, pass the flag explicitly
- The Docker image (`node:24-alpine`) satisfies this requirement out of the box

## When to use Code Mode

- When the model needs to **orchestrate multiple downstream tools in one turn** without multiple round trips
- When tool selection requires **programmatic logic** — conditionals, loops, result transformations
- When a task involves **batch parallel execution** of independent tool calls
- For complex agent workflows where the model writes the coordination logic, not just the arguments
- When downstream results are large and need **in-sandbox processing** before returning to the client

## How it works

The model receives two tools: `gateway_run_code` and `gateway_help`. It writes a JavaScript snippet that runs inside an `isolated-vm` sandbox with a built-in MCP runtime API (`catalog`, `mcp`, `result`, `artifacts`). The gateway executes the script against real downstream tools and returns the result in a single MCP response.

The sandbox is **memory- and time-limited** (configurable via `code.*` config). It has no filesystem or network access outside the MCP API surface.

## Sandbox API

```javascript
// 🔍 Discover tools
const servers = await catalog.servers()

const tools = await catalog.search('fastmcp docs', {
  serverId: 'fastmcp',     // optional: restrict to one downstream server
  requiredArgs: ['query'], // optional: filter by required argument names
  detail: 'signature',     // optional: include arg types and descriptions
  k: 5,                    // max results (prefer k over deprecated limit)
})

// 📋 Inspect a tool's full signature before calling
const details = await catalog.describe(tools[0].handle, { detail: 'signature' })

// 📞 Call a single tool
const out = await mcp.call(tools[0].handle, { query: 'quickstart' })

// 🗂️ Process results
const text = result.text(out)           // extract text content from content[]
const items = result.items(out)         // extract structured items
const filtered = result.limit(items, 1) // take first N items
const picked = result.pick(out, ['key']) // select specific keys from result

// ⚡ Batch parallel tool calls
if (tools.length >= 2) {
  const [a, b] = await mcp.batch([
    { handle: tools[0].handle, args: { query: 'quickstart' } },
    { handle: tools[1].handle, args: { query: 'installation' } },
  ])
}

// 💾 Store large results as artifacts for later retrieval
const saved = await artifacts.save(filtered, { label: 'filtered-files' })
return { saved, count: result.count(filtered), sample: text }
```

### API notes

- `result` is a **reserved global** — do not assign to it; use `return` or an expression as the snippet's final value
- `catalog.servers()` returns the exact downstream `serverId` values available in the namespace; use it only when the target integration is unclear
- Snippets may be a single expression or a block with `return`; the final value must be JSON-serializable
- `catalog.search()` returns handles scoped to the current session — do not persist them across calls
- `catalog.describe(..., { detail: "signature" })` returns required args plus short property metadata (`type`, `description`, `enum` when present)
- `result.limit()` expects an array; `result.items()` and `result.text()` unwrap MCP `content[]` arrays
- For `mcp.batch`, only combine handles that accept compatible arg shapes; use `catalog.describe` when unsure and verify the search returned enough tools before indexing
- For large or rich payloads, prefer `result.pick`, `result.limit`, `artifacts.save`, or `JSON.parse(JSON.stringify(value))` to avoid serialization issues

## Configuration

Code mode behavior is controlled under `code.*` in the config file:

| Key | Description |
| --- | ----------- |
| `code.maxConcurrentToolCalls` | Max parallel downstream calls per `mcp.batch` (default: 5) |
| `code.handleTtlSeconds` | How long search handles remain valid (default: session TTL) |
| `session.ttlSeconds` | Session lifetime; sandbox scripts must complete within this window |

See [Configuration](../CONFIGURATION.md) for full `code` and `resilience` options.

## Limitations

- Node.js 24 LTS only
- Sandbox has **no filesystem or network access** outside the built-in MCP API
- `maxConcurrentToolCalls` caps parallel execution per `mcp.batch` call
- Some MCP clients may omit the JSON-RPC `result` payload from what they expose to the model — test with a raw HTTP call to `/mcp/:namespace` when debugging

## See Also

- [Compat Mode](COMPAT-MODE.md) — compact discovery/call mode for large catalogs without a sandbox
- [Default Mode](DEFAULT-MODE.md) — exposes all tools directly
- [Configuration](../CONFIGURATION.md) — `code.*` and `resilience` settings
