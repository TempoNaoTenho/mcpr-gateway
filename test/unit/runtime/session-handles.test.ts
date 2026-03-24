import { describe, it, expect, beforeEach } from 'vitest'
import { HandleRegistry } from '../../../src/runtime/handle-registry.js'

describe('HandleRegistry TTL', () => {
  it('handle expires after TTL', async () => {
    const registry = new HandleRegistry(100)
    const handle = registry.register({ serverId: 's', namespace: 'ns', name: 'tool' })
    expect(registry.resolve(handle)).toBeDefined()

    await new Promise((r) => setTimeout(r, 150))
    expect(registry.resolve(handle)).toBeUndefined()
  })

  it('handle refreshed on re-registration', async () => {
    const registry = new HandleRegistry(100)
    const target = { serverId: 's', namespace: 'ns', name: 'tool' }
    registry.register(target)

    await new Promise((r) => setTimeout(r, 50))
    registry.register(target)
    await new Promise((r) => setTimeout(r, 60))

    expect(registry.resolve('h_1')).toBeDefined()
  })

  it('resolve() removes expired handles', async () => {
    const registry = new HandleRegistry(100)
    const handle1 = registry.register({ serverId: 's1', namespace: 'ns', name: 'tool1' })
    registry.register({ serverId: 's2', namespace: 'ns', name: 'tool2' })

    await new Promise((r) => setTimeout(r, 150))

    expect(registry.resolve(handle1)).toBeUndefined()
    expect(registry.resolve('h_2')).toBeUndefined()
  })
})

describe('HandleRegistry entries()', () => {
  it('entries() excludes expired handles', async () => {
    const registry = new HandleRegistry(100)
    registry.register({ serverId: 's1', namespace: 'ns', name: 'tool1' })
    registry.register({ serverId: 's2', namespace: 'ns', name: 'tool2' })

    await new Promise((r) => setTimeout(r, 150))

    const entries = registry.entries()
    expect(entries).toHaveLength(0)
  })

  it('re-registration creates new handle after expiry', async () => {
    const registry = new HandleRegistry(100)
    registry.register({ serverId: 's1', namespace: 'ns', name: 'tool1' })

    await new Promise((r) => setTimeout(r, 150))
    const handle1New = registry.register({ serverId: 's1', namespace: 'ns', name: 'tool1' })

    expect(handle1New).toBe('h_2')
    const entries = registry.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0].handle).toBe('h_2')
  })
})
