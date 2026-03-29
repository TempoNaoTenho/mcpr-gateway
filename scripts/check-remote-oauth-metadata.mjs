#!/usr/bin/env node
const baseUrl = (process.argv[2] ?? process.env['MCP_GATEWAY_BASE_URL'] ?? '').trim().replace(/\/$/, '')
const namespace = (process.argv[3] ?? process.env['MCP_GATEWAY_NAMESPACE'] ?? 'default').trim()

if (!baseUrl) {
  console.error('Usage: node scripts/check-remote-oauth-metadata.mjs <base-url> [namespace]')
  console.error('Example: node scripts/check-remote-oauth-metadata.mjs https://mcpr-gateway.onrender.com default')
  process.exit(1)
}

const targets = [
  '/.well-known/oauth-authorization-server',
  `/.well-known/oauth-authorization-server/mcp/${namespace}`,
  `/mcp/${namespace}/.well-known/oauth-authorization-server`,
  '/.well-known/openid-configuration',
  `/.well-known/openid-configuration/mcp/${namespace}`,
  `/mcp/${namespace}/.well-known/openid-configuration`,
  `/.well-known/oauth-protected-resource/mcp/${namespace}`,
]

let hasFailure = false

for (const path of targets) {
  const url = `${baseUrl}${path}`
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
    })
    const status = `${res.status} ${res.statusText}`.trim()
    console.log(`${status.padEnd(18)} ${url}`)
    if (!res.ok) hasFailure = true
  } catch (error) {
    hasFailure = true
    console.log(`ERR`.padEnd(18), url)
    console.error(error instanceof Error ? error.message : String(error))
  }
}

if (hasFailure) {
  process.exit(1)
}
