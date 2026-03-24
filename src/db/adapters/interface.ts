/**
 * Database adapter boundary for the gateway persistence layer.
 * Today the process uses `SqliteAdapter` only; a future `PostgresAdapter` (or similar) can implement the same contract
 * while repositories keep taking a driver-specific client (`SqliteDb`, etc.) from that adapter.
 */
export interface IDbAdapter {
  /** SQLite: file path or `:memory:`. Future adapters may interpret a DSN or config object instead. */
  connect(path: string): void
  disconnect(): void
  isConnected(): boolean
}
