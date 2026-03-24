import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { openStandaloneSqlite } from '../../src/db/adapters/sqlite/index.js'
import { SqliteSessionRepository } from '../../src/repositories/sessions/sqlite.js'

let counter = 0

/** Per-call isolated SQLite session store for tests (closes the underlying DB with `close()`). */
export function createTempSqliteSessionStore(): {
  store: SqliteSessionRepository
  close: () => void
} {
  const id = `${Date.now()}-${randomBytes(8).toString('hex')}-${++counter}`
  const dir = join(tmpdir(), 'mcp-gateway-test', id)
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'sessions.db')
  const { db, close } = openStandaloneSqlite(dbPath)
  return {
    store: new SqliteSessionRepository(db),
    close,
  }
}
