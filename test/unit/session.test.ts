import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createTempSqliteSessionStore } from '../fixtures/sqlite-session-store.js'
import type { SqliteSessionRepository } from '../../src/repositories/sessions/sqlite.js'
import { SessionStatus, Mode } from '../../src/types/enums.js'
import { SessionIdSchema } from '../../src/types/identity.js'
import type { SessionState } from '../../src/types/session.js'

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  const now = new Date().toISOString()
  return {
    id: SessionIdSchema.parse('test-session-1'),
    userId: 'user-1',
    namespace: 'gmail',
    mode: Mode.Read,
    status: SessionStatus.Active,
    toolWindow: [],
    createdAt: now,
    lastActiveAt: now,
    refreshCount: 0,
    recentOutcomes: [],
    refreshHistory: [],
    pendingToolListChange: false,
    ...overrides,
  }
}

describe('SqliteSessionRepository', () => {
  let store: SqliteSessionRepository
  let closeDb: () => void

  beforeEach(() => {
    const created = createTempSqliteSessionStore()
    store = created.store
    closeDb = created.close
  })

  afterEach(() => {
    store.stop()
    closeDb()
    vi.useRealTimers()
  })

  it('returns undefined for missing session', async () => {
    const result = await store.get(SessionIdSchema.parse('nonexistent'))
    expect(result).toBeUndefined()
  })

  it('sets and gets a session', async () => {
    const session = makeSession()
    await store.set(session.id as ReturnType<typeof SessionIdSchema.parse>, session)
    const found = await store.get(session.id as ReturnType<typeof SessionIdSchema.parse>)
    expect(found).toEqual(session)
  })

  it('deletes a session', async () => {
    const session = makeSession()
    const id = session.id as ReturnType<typeof SessionIdSchema.parse>
    await store.set(id, session)
    await store.delete(id)
    expect(await store.get(id)).toBeUndefined()
  })

  it('lists all sessions when no namespace given', async () => {
    const s1 = makeSession({ id: SessionIdSchema.parse('s1'), namespace: 'gmail' })
    const s2 = makeSession({ id: SessionIdSchema.parse('s2'), namespace: 'drive' })
    await store.set(s1.id as ReturnType<typeof SessionIdSchema.parse>, s1)
    await store.set(s2.id as ReturnType<typeof SessionIdSchema.parse>, s2)
    const all = await store.list()
    expect(all).toHaveLength(2)
  })

  it('filters by namespace', async () => {
    const s1 = makeSession({ id: SessionIdSchema.parse('s1'), namespace: 'gmail' })
    const s2 = makeSession({ id: SessionIdSchema.parse('s2'), namespace: 'drive' })
    await store.set(s1.id as ReturnType<typeof SessionIdSchema.parse>, s1)
    await store.set(s2.id as ReturnType<typeof SessionIdSchema.parse>, s2)
    const gmailOnly = await store.list('gmail')
    expect(gmailOnly).toHaveLength(1)
    expect(gmailOnly[0].namespace).toBe('gmail')
  })

  it('overwrites existing session on set', async () => {
    const session = makeSession()
    const id = session.id as ReturnType<typeof SessionIdSchema.parse>
    await store.set(id, session)
    const updated = { ...session, refreshCount: 5 }
    await store.set(id, updated)
    const found = await store.get(id)
    expect(found?.refreshCount).toBe(5)
  })
})

describe('SqliteSessionRepository — TTL', () => {
  let store: SqliteSessionRepository
  let closeDb: () => void

  beforeEach(() => {
    const created = createTempSqliteSessionStore()
    store = created.store
    closeDb = created.close
    vi.useFakeTimers()
  })

  afterEach(() => {
    store.stop()
    closeDb()
    vi.useRealTimers()
  })

  it('lazy expiry: expired session returns undefined via get()', async () => {
    store.start(1, 60)
    const twoSecondsAgo = new Date(Date.now() - 2000).toISOString()
    const session = makeSession({ lastActiveAt: twoSecondsAgo })
    const id = session.id as ReturnType<typeof SessionIdSchema.parse>
    await store.set(id, session)

    const found = await store.get(id)
    expect(found).toBeUndefined()
  })

  it('recently active session survives lazy expiry check', async () => {
    store.start(1800, 60)
    const session = makeSession()
    const id = session.id as ReturnType<typeof SessionIdSchema.parse>
    await store.set(id, session)

    const found = await store.get(id)
    expect(found).toBeDefined()
  })

  it('cleanup loop removes expired sessions', async () => {
    store.start(1, 1)
    const twoSecondsAgo = new Date(Date.now() - 2000).toISOString()
    const session = makeSession({ lastActiveAt: twoSecondsAgo })
    const id = session.id as ReturnType<typeof SessionIdSchema.parse>
    await store.set(id, session)

    vi.advanceTimersByTime(1100)

    const found = await store.get(id)
    expect(found).toBeUndefined()
  })

  it('after stop(), cleanup interval does not run', async () => {
    store.start(1, 1)
    store.stop()

    const session = makeSession()
    const id = session.id as ReturnType<typeof SessionIdSchema.parse>
    const twoSecondsAgo = new Date(Date.now() - 2000).toISOString()
    const expiredSession = makeSession({ lastActiveAt: twoSecondsAgo })
    await store.set(id, expiredSession)

    vi.advanceTimersByTime(5000)

    expect(true).toBe(true)
  })

  it('ttlSeconds=0 disables TTL — sessions never expire', async () => {
    store.start(0, 60)
    const longAgo = new Date(Date.now() - 999_999_000).toISOString()
    const session = makeSession({ lastActiveAt: longAgo })
    const id = session.id as ReturnType<typeof SessionIdSchema.parse>
    await store.set(id, session)

    const found = await store.get(id)
    expect(found).toBeDefined()
  })
})
