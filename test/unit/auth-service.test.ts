import { describe, expect, it } from 'vitest'
import { resolveIdentity } from '../../src/auth/service.js'

describe('resolveIdentity', () => {
  it('prefers persisted bearer tokens even when bootstrap auth mode is mock_dev', () => {
    const identity = resolveIdentity('Bearer persisted-token', {
      mode: 'mock_dev',
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

  it('falls back to mock_dev parsing when the bearer token is not a persisted client token', () => {
    const identity = resolveIdentity('Bearer inspector:admin', {
      mode: 'mock_dev',
      staticKeys: {
        persisted: {
          userId: 'service-user',
          roles: ['user'],
        },
      },
    })

    expect(identity).toEqual({
      sub: 'inspector',
      roles: ['admin'],
    })
  })
})
