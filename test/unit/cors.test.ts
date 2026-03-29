import { describe, expect, it } from 'vitest'
import { isBrowserOriginAllowed, LOOPBACK_ORIGIN } from '../../src/gateway/cors.js'

describe('isBrowserOriginAllowed', () => {
  it('allows loopback origins without an explicit allowlist', () => {
    expect(LOOPBACK_ORIGIN.test('http://localhost:6274')).toBe(true)
    expect(isBrowserOriginAllowed('http://localhost:6274', undefined)).toBe(true)
  })

  it('allows exact configured origins', () => {
    expect(isBrowserOriginAllowed('https://chatgpt.com', ['https://chatgpt.com'])).toBe(true)
    expect(isBrowserOriginAllowed('https://claude.com', ['https://claude.com'])).toBe(true)
  })

  it('tolerates a trailing slash in configured origins', () => {
    expect(isBrowserOriginAllowed('https://chatgpt.com', ['https://chatgpt.com/'])).toBe(true)
  })

  it('rejects prefix matches that are not the same origin', () => {
    expect(
      isBrowserOriginAllowed('https://chatgpt.com.attacker.tld', ['https://chatgpt.com']),
    ).toBe(false)
  })

  it('rejects non-loopback origins when no allowlist is configured', () => {
    expect(isBrowserOriginAllowed('https://chatgpt.com', undefined)).toBe(false)
  })
})
