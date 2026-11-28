import { tenantColumns, tenantIsolation } from '@hk/platform/db';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgSchema,
} from 'drizzle-orm/pg-core';

/**
 * What is known about each stored file. The bytes are in object storage;
 * this table says what they are and where.
 *
 *   export const files = filesTable(core);
 *
 * Needs Henson's line-by-line review, like every table definition that
 * becomes a migration.
 *
 * - A business table: tenantColumns, the tenant index and the row-level
 *   security policy.
 * - object_key is unique: two records never point at the same bytes.
 * - The checks tie size and hash to the status: unknown while pending, known
 *   from then on.
 * - uploaded_at and uploaded_by are the application's own values. They are
 *   kept apart from created_at and created_by, which the database and the
 *   repository stamp.
 */
export const filesTable = (schema: PgSchema) =>
  schema.table(
    'files',
    {
      ...tenantColumns,
      /** "attachment", "image", "import" or "export". */
      purpose: text('purpose').notNull(),
      /** The cleaned file name, for display and download. */
      name: text('name').notNull(),
      contentType: text('content_type').notNull(),
      /** "pending", "stored" or "deleted". */
      status: text('status').notNull(),
      /** Bytes. Null while pending. */
      size: bigint('size', { mode: 'number' }),
      /** SHA-256 of the bytes, 64 hex characters. Null while pending. */
      sha256: text('sha256'),
      objectKey: text('object_key').notNull(),
      uploadedAt: timestamp('uploaded_at', {
        withTimezone: true,
        precision: 3,
      }).notNull(),
      uploadedBy: uuid('uploaded_by'),
    },
    (table) => [
      uniqueIndex('files_object_key_uq').on(table.objectKey),
      check(
        'files_status',
        sql`${table.status} in ('pending', 'stored', 'deleted')`,
      ),
      check(
        'files_stored_facts',
        // "is not null" is spelled out on purpose. A check only rejects a
        // definite false, and `null >= 0` is null, which would let a stored
        // file with no size through.
        sql`(${table.status} = 'pending' and ${table.size} is null and ${table.sha256} is null) or (${table.status} <> 'pending' and ${table.size} is not null and ${table.size} >= 0 and ${table.sha256} is not null and ${table.sha256} ~ '^[0-9a-f]{64}$')`,
      ),
      ...tenantIsolation('files', table),
    ],
  );

export type FilesTable = ReturnType<typeof filesTable>;
