/**
 * Resolve JWKS URI for an OAuth/OIDC issuer (RFC 8414 / OpenID Discovery).
 */
export async function discoverJwksUri(issuer: string, signal?: AbortSignal): Promise<string> {
  const base = issuer.replace(/\/$/, '')
  const endpoints = [
    `${base}/.well-known/openid-configuration`,
    `${base}/.well-known/oauth-authorization-server`,
  ]

  const ac = signal ?? AbortSignal.timeout(5000)

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: ac })
      if (res.ok) {
        const body = (await res.json()) as { jwks_uri?: unknown }
        if (typeof body.jwks_uri === 'string' && body.jwks_uri.length > 0) {
          return body.jwks_uri
        }
      }
    } catch {
      /* try next */
    }
  }

  return `${base}/.well-known/jwks.json`
}
