import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

export const sessions = sqliteTable('sessions', {
  id:         text('id').primaryKey(),
  userId:     text('user_id').notNull(),
  namespace:  text('namespace').notNull(),
  mode:       text('mode').notNull(),
  status:     text('status').notNull(),
  stateJson:  text('state_json').notNull(),
  createdAt:  integer('created_at').notNull(),
  lastActive: integer('last_active').notNull(),
  expiresAt:  integer('expires_at'),
})

export const auditEvents = sqliteTable('audit_events', {
  id:          integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  eventType:   text('event_type').notNull(),
  sessionId:   text('session_id'),
  userId:      text('user_id'),
  namespace:   text('namespace'),
  toolName:    text('tool_name'),
  serverId:    text('server_id'),
  outcome:     text('outcome'),
  latencyMs:   integer('latency_ms'),
  payloadJson: text('payload_json').notNull(),
  occurredAt:  integer('occurred_at').notNull(),
})

export const configVersions = sqliteTable('config_versions', {
  id:         integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  version:    integer('version').notNull().unique(),
  configJson: text('config_json').notNull(),
  source:     text('source').notNull(),
  createdBy:  text('created_by').notNull(),
  createdAt:  integer('created_at').notNull(),
  comment:    text('comment'),
  isActive:   integer('is_active', { mode: 'number' }).notNull().default(0),
})

export const downstreamAuthCredentials = sqliteTable('downstream_auth_credentials', {
  serverId:    text('server_id').notNull(),
  kind:        text('kind').notNull(),
  ciphertext:  text('ciphertext').notNull(),
  iv:          text('iv').notNull(),
  tag:         text('tag').notNull(),
  metaJson:    text('meta_json'),
  updatedAt:   integer('updated_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.serverId, table.kind] }),
}))
