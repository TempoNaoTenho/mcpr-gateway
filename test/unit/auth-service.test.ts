import { describe, expect, it } from 'vitest'
import { resolveIdentity } from '../../src/auth/service.js'

describe('resolveIdentity', () => {
  it('resolves persisted bearer tokens from staticKeys', () => {
    const identity = resolveIdentity('Bearer persisted-token', {
      mode: 'static_key',
      staticKeys: {
        'persisted-token': {
          userId: 'service-user',
          roles: ['user'],
        },
      },
    })

    expect(identity).toEqual({
      sub: 'service-user',
      roles: ['user'],
    })
  })

  it('returns anonymous when bearer token is not persisted', () => {
    const identity = resolveIdentity('Bearer inspector:admin', {
      mode: 'static_key',
      staticKeys: {
        persisted: {
          userId: 'service-user',
          roles: ['user'],
        },
      },
    })

    expect(identity).toEqual({ sub: 'anonymous', roles: [] })
  })
})
