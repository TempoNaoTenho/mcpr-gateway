import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { IDbAdapter } from '../interface.js'
import * as schema from './schema.js'

export type SqliteDb = BetterSQLite3Database<typeof schema>

/** Raw SQL migrations shared by the process-wide adapter and standalone test DB handles. */
export function applyGatewaySqliteSchema(sqlite: InstanceType<typeof Database>): void {
  sqlite.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT    PRIMARY KEY,
        user_id     TEXT    NOT NULL,
        namespace   TEXT    NOT NULL,
        mode        TEXT    NOT NULL,
        status      TEXT    NOT NULL,
        state_json  TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        last_active INTEGER NOT NULL,
        expires_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_namespace   ON sessions(namespace);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at  ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS audit_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type   TEXT    NOT NULL,
        session_id   TEXT,
        user_id      TEXT,
        namespace    TEXT,
        tool_name    TEXT,
        server_id    TEXT,
        outcome      TEXT,
        latency_ms   INTEGER,
        payload_json TEXT    NOT NULL,
        occurred_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_session_id  ON audit_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_user_id     ON audit_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_event_type  ON audit_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_audit_occurred_at ON audit_events(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_audit_tool_name   ON audit_events(tool_name);

      CREATE TABLE IF NOT EXISTS config_versions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        version     INTEGER NOT NULL UNIQUE,
        config_json TEXT    NOT NULL,
        source      TEXT    NOT NULL,
        created_by  TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        comment     TEXT,
        is_active   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS downstream_auth_credentials (
        server_id   TEXT    NOT NULL,
        kind        TEXT    NOT NULL,
        ciphertext  TEXT    NOT NULL,
        iv          TEXT    NOT NULL,
        tag         TEXT    NOT NULL,
        meta_json   TEXT,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (server_id, kind)
      );
    `)
}

/**
 * Opens an isolated SQLite database through {@link SqliteAdapter} (same code path as the process singleton).
 * Use in tests when multiple DBs must exist at once; the process-wide {@link sqliteAdapter} is for normal startup.
 */
export function openStandaloneSqlite(path: string): { db: SqliteDb; close: () => void } {
  const adapter = new SqliteAdapter()
  adapter.connect(path)
  return {
    db: adapter.getDb(),
    close: () => adapter.disconnect(),
  }
}

/** SQLite implementation of {@link IDbAdapter}; used as the single production DB driver until a second adapter exists. */
export class SqliteAdapter implements IDbAdapter {
  private _db: SqliteDb | null = null
  private _sqlite: InstanceType<typeof Database> | null = null

  connect(path: string): void {
    this.disconnect()
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true })
    }

    const sqlite = new Database(path)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    applyGatewaySqliteSchema(sqlite)
    this._sqlite = sqlite
    this._db = drizzle(sqlite, { schema })
  }

  disconnect(): void {
    this._sqlite?.close()
    this._sqlite = null
    this._db = null
  }

  isConnected(): boolean {
    return this._db !== null
  }

  getDb(): SqliteDb {
    if (!this._db) throw new Error('[db] SQLite adapter not connected — call connect() first')
    return this._db
  }
}

export const sqliteAdapter = new SqliteAdapter()
