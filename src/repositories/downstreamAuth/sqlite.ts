import { and, eq } from 'drizzle-orm'
import type { SqliteDb } from '../../db/index.js'
import { downstreamAuthCredentials } from '../../db/adapters/sqlite/schema.js'
import type {
  IDownstreamAuthRepository,
  StoredDownstreamCredential,
  DownstreamCredentialKind,
} from './interface.js'

export class SqliteDownstreamAuthRepository implements IDownstreamAuthRepository {
  constructor(private readonly db: SqliteDb) {}

  async get(serverId: string, kind: DownstreamCredentialKind): Promise<StoredDownstreamCredential | undefined> {
    const row = this.db
      .select()
      .from(downstreamAuthCredentials)
      .where(and(eq(downstreamAuthCredentials.serverId, serverId), eq(downstreamAuthCredentials.kind, kind)))
      .limit(1)
      .all()[0]

    if (!row) return undefined
    return {
      serverId: row.serverId,
      kind: row.kind as DownstreamCredentialKind,
      ciphertext: row.ciphertext,
      iv: row.iv,
      tag: row.tag,
      metaJson: row.metaJson ?? undefined,
      updatedAt: row.updatedAt,
    }
  }

  async save(input: StoredDownstreamCredential): Promise<void> {
    this.db
      .insert(downstreamAuthCredentials)
      .values({
        serverId: input.serverId,
        kind: input.kind,
        ciphertext: input.ciphertext,
        iv: input.iv,
        tag: input.tag,
        metaJson: input.metaJson ?? null,
        updatedAt: input.updatedAt,
      })
      .onConflictDoUpdate({
        target: [downstreamAuthCredentials.serverId, downstreamAuthCredentials.kind],
        set: {
          ciphertext: input.ciphertext,
          iv: input.iv,
          tag: input.tag,
          metaJson: input.metaJson ?? null,
          updatedAt: input.updatedAt,
        },
      })
      .run()
  }

  async delete(serverId: string, kind?: DownstreamCredentialKind): Promise<void> {
    if (kind) {
      this.db
        .delete(downstreamAuthCredentials)
        .where(and(eq(downstreamAuthCredentials.serverId, serverId), eq(downstreamAuthCredentials.kind, kind)))
        .run()
      return
    }

    this.db.delete(downstreamAuthCredentials).where(eq(downstreamAuthCredentials.serverId, serverId)).run()
  }

  async listByServer(serverId: string): Promise<StoredDownstreamCredential[]> {
    return this.db
      .select()
      .from(downstreamAuthCredentials)
      .where(eq(downstreamAuthCredentials.serverId, serverId))
      .all()
      .map((row) => ({
        serverId: row.serverId,
        kind: row.kind as DownstreamCredentialKind,
        ciphertext: row.ciphertext,
        iv: row.iv,
        tag: row.tag,
        metaJson: row.metaJson ?? undefined,
        updatedAt: row.updatedAt,
      }))
  }
}
