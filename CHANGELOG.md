# Changelog

## Unreleased

### Branding and packaging

- Product name **MCPR Gateway**; npm package and CLI binary **`mcpr-gateway`** (replaces `mcp-session-gateway`).
- Docs and Codex examples use **`MCPR_GATEWAY_TOKEN`** and **`[mcp_servers.mcpr-gateway]`**; MCP `serverInfo.name` / downstream `clientInfo.name` slug is **`mcpr-gateway`**.

### Release readiness

- `code` mode validated on **Node 22/24 LTS** with `isolated-vm`
- **Node 25** and other odd-numbered releases are not supported
- Docker runtime aligned to **Node 24**
- `isolated-vm` deployments must start with `--no-node-snapshot`

### Code mode

- fixed runtime compatibility issues that caused `code` mode instability on unsupported Node versions
- improved `gateway_run_code` behavior for:
  - plain expressions and block snippets
  - `catalog.list/search`
  - `mcp.call`
  - `mcp.batch`
  - `artifacts.save/list`
- improved LLM-facing error messages for:
  - reserved `result`
  - non-serializable return values
  - bridge operation timeouts

### Operational caveats

- MCP/JSON-RPC tool failures may return **HTTP 200** with an `error` object in the response body
- some MCP clients may not expose the JSON-RPC `result` payload to the model even when the gateway returned it successfully
- when validating integrations, compare client-native MCP behavior with raw HTTP JSON-RPC requests

### Publication status

- recommended status: **publish with caveats**
- suitable for internal use and controlled external testing on supported runtimes
- before broad external publication, keep one final validation pass on **Node 24** for:
  - large payloads
  - client-specific result rendering
  - downstream error presentation
