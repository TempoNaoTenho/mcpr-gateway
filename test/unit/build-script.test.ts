import { describe, expect, it } from 'vitest'

import { validateNodeRuntime } from '../../scripts/build.mjs'

describe('build script helpers', () => {
  it('accepts Node 24 and rejects other runtimes', () => {
    expect(validateNodeRuntime('24.14.1').ok).toBe(true)
    expect(validateNodeRuntime('22.17.0').ok).toBe(false)
    expect(validateNodeRuntime('25.0.0').ok).toBe(false)
  })
})
