import { describe, it, expect } from 'vitest'
import { extractIdentity } from '../../src/auth/stub.js'

describe('extractIdentity', () => {
  it('returns anonymous identity when header is absent', () => {
    const identity = extractIdentity(undefined)
    expect(identity.sub).toBe('anonymous')
    expect(identity.roles).toEqual(['user'])
  })

  it('returns anonymous identity for empty string', () => {
    const identity = extractIdentity('')
    expect(identity.sub).toBe('anonymous')
    expect(identity.roles).toEqual(['user'])
  })

  it('extracts sub from Bearer token', () => {
    const identity = extractIdentity('Bearer mytoken123')
    expect(identity.sub).toBe('mytoken123')
    expect(identity.roles).toEqual(['user'])
  })

  it('extracts sub from Bearer token case-insensitively', () => {
    const identity = extractIdentity('bearer anothertoken')
    expect(identity.sub).toBe('anothertoken')
    expect(identity.roles).toEqual(['user'])
  })

  it('returns anonymous for malformed auth header (no Bearer)', () => {
    const identity = extractIdentity('Basic somebase64value')
    expect(identity.sub).toBe('anonymous')
    expect(identity.roles).toEqual(['user'])
  })
})
