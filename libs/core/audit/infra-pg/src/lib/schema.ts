import { tenantColumns, tenantIsolation } from '@hk/platform/db';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  type PgSchema,
} from 'drizzle-orm/pg-core';

/**
 * The audit trail of every business: one row per event, never changed.
 *
 *   export const auditEvents = auditEventsTable(core);
 *
 * Needs Henson's line-by-line review, like every table definition that
 * becomes a migration.
 *
 * - It is a business table: tenantColumns, the tenant index and the
 *   row-level security policy. A business sees and writes only its own
 *   events.
 * - (business_id, sequence) is unique. Two events can never claim the same
 *   place in a chain, whatever the application does.
 * - The checks keep out rows this code could never have written.
 * - `updated_at` and `version` come with tenantColumns and never change
 *   here: the application has no update, and the app role is refused UPDATE
 *   and DELETE on this table (see write-once.ts).
 *
 * `id` is the event's id, made by the caller and covered by the hash.
 */
export const auditEventsTable = (schema: PgSchema) =>
  schema.table(
    'audit_events',
    {
      ...tenantColumns,
      /** Position in the business's chain, from 1. */
      sequence: bigint('sequence', { mode: 'number' }).notNull(),
      occurredAt: timestamp('occurred_at', {
        withTimezone: true,
        precision: 3,
      }).notNull(),
      /** "user", "service" or "system". */
      actorType: text('actor_type').notNull(),
      /** A user id, a service name, or null for the system. */
      actorId: text('actor_id'),
      action: text('action').notNull(),
      /** "sales.invoice". */
      entityType: text('entity_type').notNull(),
      entityId: text('entity_id'),
      details: jsonb('details').notNull(),
      requestId: text('request_id'),
      /** 64 hex characters: the hash of the event before, or zeros for the first. */
      previousHash: text('previous_hash').notNull(),
      /** 64 hex characters: SHA-256 over this event's content and previous_hash. */
      hash: text('hash').notNull(),
    },
    (table) => [
      uniqueIndex('audit_events_business_sequence_uq').on(
        table.businessId,
        table.sequence,
      ),
      check('audit_events_sequence_positive', sql`${table.sequence} > 0`),
      check(
        'audit_events_hash_format',
        sql`${table.hash} ~ '^[0-9a-f]{64}$' and ${table.previousHash} ~ '^[0-9a-f]{64}$'`,
      ),
      check(
        'audit_events_actor_type',
        sql`${table.actorType} in ('user', 'service', 'system')`,
      ),
      ...tenantIsolation('audit_events', table),
    ],
  );

export type AuditEventsTable = ReturnType<typeof auditEventsTable>;
