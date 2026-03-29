import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from 'jose'
import type { InboundOAuthConfig, IssuerConfig } from '../config/oauth-schemas.js'
import type { UserIdentity } from '../types/identity.js'
import { discoverJwksUri } from './oauth-discovery.js'
import { resourceAudienceForNamespace } from './oauth-config.js'

export class OAuthJwtValidator {
  private readonly jwksByIssuerUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
  private readonly resolvedJwksUri = new Map<string, string>()

  private async resolveJwksUrl(issuerCfg: IssuerConfig): Promise<string> {
    if (issuerCfg.jwksUri) return issuerCfg.jwksUri
    const cacheKey = issuerCfg.issuer
    let resolved = this.resolvedJwksUri.get(cacheKey)
    if (!resolved) {
      resolved = await discoverJwksUri(issuerCfg.issuer)
      this.resolvedJwksUri.set(cacheKey, resolved)
    }
    return resolved
  }

  private getJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
    let set = this.jwksByIssuerUrl.get(jwksUrl)
    if (!set) {
      set = createRemoteJWKSet(new URL(jwksUrl))
      this.jwksByIssuerUrl.set(jwksUrl, set)
    }
    return set
  }

  private issuerConfigForTokenIss(oauth: InboundOAuthConfig, iss: string): IssuerConfig | undefined {
    const normalized = iss.replace(/\/$/, '')
    return oauth.authorizationServers.find((s) => s.issuer.replace(/\/$/, '') === normalized)
  }

  private audienceMatches(payload: JWTPayload, expected: string): boolean {
    const aud = payload.aud
    if (aud === undefined) return false
    if (typeof aud === 'string') return aud === expected
    if (Array.isArray(aud)) return aud.includes(expected)
    return false
  }

  private rolesFromPayload(payload: JWTPayload, rolesClaim: string): string[] {
    const raw = payload[rolesClaim]
    if (raw === undefined) return []
    if (Array.isArray(raw)) {
      return raw.filter((r): r is string => typeof r === 'string')
    }
    if (typeof raw === 'string') {
      return raw.split(/\s+/).filter(Boolean)
    }
    return []
  }

  /**
   * Validate JWT access token; return UserIdentity or null.
   */
  async validate(
    token: string,
    oauth: InboundOAuthConfig,
    namespace: string,
  ): Promise<UserIdentity | null> {
    let decoded: JWTPayload
    try {
      decoded = decodeJwt(token)
    } catch {
      return null
    }

    const iss = typeof decoded.iss === 'string' ? decoded.iss : ''
    if (!iss) return null

    const issuerCfg = this.issuerConfigForTokenIss(oauth, iss)
    if (!issuerCfg) return null

    const jwksUrl = await this.resolveJwksUrl(issuerCfg)
    const expectedAud = issuerCfg.audience ?? resourceAudienceForNamespace(oauth, namespace)
    const jwks = this.getJwks(jwksUrl)

    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(token, jwks, {
        issuer: iss,
        audience: expectedAud,
      }))
    } catch {
      return null
    }

    if (!this.audienceMatches(payload, expectedAud)) {
      return null
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : ''
    if (!sub) return null

    const roles = this.rolesFromPayload(payload, issuerCfg.rolesClaim)
    return { sub, roles }
  }
}

/** Singleton for process lifetime */
let sharedValidator: OAuthJwtValidator | undefined

export function getOAuthJwtValidator(): OAuthJwtValidator {
  if (!sharedValidator) sharedValidator = new OAuthJwtValidator()
  return sharedValidator
}
