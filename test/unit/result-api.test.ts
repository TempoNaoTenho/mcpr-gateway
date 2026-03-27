import { describe, expect, it } from 'vitest'
import { items, limit, text } from '../../src/runtime/result-api.js'

describe('result.limit', () => {
  it('returns the first n items from an array', () => {
    expect(limit([1, 2, 3], 2)).toEqual([1, 2])
  })

  it('throws an actionable error for non-array values', () => {
    expect(() => limit({ content: [1, 2, 3] } as never, 1)).toThrow(
      'result.limit expects an array; pass an array value such as out.content instead of the whole object.'
    )
  })
})

describe('result.items', () => {
  it('returns content blocks from tool results', () => {
    expect(items({ content: [{ type: 'text', text: 'hello' }] })).toEqual([
      { type: 'text', text: 'hello' },
    ])
  })

  it('passes arrays through unchanged', () => {
    expect(items([1, 2, 3])).toEqual([1, 2, 3])
  })
})

describe('result.text', () => {
  it('concatenates text blocks from tool results', () => {
    expect(
      text({
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      })
    ).toBe('first\nsecond')
  })

  it('returns strings unchanged', () => {
    expect(text('plain text')).toBe('plain text')
  })
})
