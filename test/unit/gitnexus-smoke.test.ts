import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { app } from '../../src/index.js'

beforeAll(async () => {
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('GitNexus smoke test', () => {
  it('can reach the smallest indexed app surface', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })
})
