import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { OAuthJwtValidator } from '../../src/auth/oauth-validator.js'
import type { InboundOAuthConfig } from '../../src/config/oauth-schemas.js'

describe('OAuthJwtValidator', () => {
  it('validates a JWT when jwksUri serves the signing key', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
    const pub = await exportJWK(publicKey)
    const jwksBody = JSON.stringify({
      keys: [{ ...pub, kid: 'unit-kid', use: 'sig' }],
    })

    const server = createServer((req, res) => {
      if (req.url?.startsWith('/jwks')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(jwksBody)
        return
      }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const jwksUrl = `http://127.0.0.1:${port}/jwks`

    try {
      const oauth: InboundOAuthConfig = {
        publicBaseUrl: 'https://gateway.example',
        authorizationServers: [
          {
            issuer: 'https://issuer.example',
            jwksUri: jwksUrl,
            rolesClaim: 'roles',
          },
        ],
      }

      const token = await new SignJWT({ roles: ['user', 'admin'] })
        .setProtectedHeader({ alg: 'RS256', kid: 'unit-kid' })
        .setIssuer('https://issuer.example')
        .setAudience('https://gateway.example/mcp/acct')
        .setSubject('alice')
        .setIssuedAt()
        .setExpirationTime('2h')
        .sign(privateKey)

      const validator = new OAuthJwtValidator()
      const identity = await validator.validate(token, oauth, 'acct')
      expect(identity).toEqual({ sub: 'alice', roles: ['user', 'admin'] })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  })

  it('returns null when issuer is not configured', async () => {
    const validator = new OAuthJwtValidator()
    const oauth: InboundOAuthConfig = {
      publicBaseUrl: 'https://gateway.example',
      authorizationServers: [{ issuer: 'https://expected.example', rolesClaim: 'roles' }],
    }
    const { privateKey } = await generateKeyPair('RS256')
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://other.example')
      .setAudience('https://gateway.example/mcp/ns')
      .setSubject('x')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey)

    await expect(validator.validate(token, oauth, 'ns')).resolves.toBeNull()
  })
})
