import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgPolicy,
  timestamp,
  uuid,
  type AnyPgColumn,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

/**
 * The columns every business table starts with.
 *
 *   export const invoices = sales.table(
 *     'invoices',
 *     { ...tenantColumns, number: text('number').notNull() },
 *     (table) => [...tenantIsolation('invoices', table)],
 *   );
 *
 * id         A UUID v7 made by the caller, so a device can create rows offline.
 * version    Optimistic concurrency. ScopedRepository checks and increments it.
 * createdBy  The user from the tenant context. Null for system work.
 */
export const tenantColumns = {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  businessId: uuid('business_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdBy: uuid('created_by'),
  version: integer('version').notNull().default(1),
};

/** Add to tables whose rows belong to a branch. */
export const branchColumn = {
  branchId: uuid('branch_id'),
};

/** The session settings every tenant transaction sets, and every policy reads. */
export const TENANT_SETTING = 'app.tenant_id';
export const BUSINESS_SETTING = 'app.business_id';

export const TENANT_POLICY_NAME = 'tenant_isolation';

/**
 * The row-level security rule: a row is visible, and may be written, only
 * when it belongs to the tenant and business of the current transaction.
 *
 * `current_setting(…, true)` gives NULL instead of an error when the setting
 * was never set, and nullif covers the empty string a setting holds after the
 * transaction that set it has ended. Either way the comparison is NULL, which
 * is not true, so with no tenant set no row matches.
 */
export const tenantPredicate = sql`tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid and business_id = nullif(current_setting('app.business_id', true), '')::uuid`;

/**
 * The index and the row-level security policy of a business table. Declaring
 * the policy also makes drizzle-kit emit ENABLE ROW LEVEL SECURITY.
 *
 * The policy applies to every role except superusers and the table's owner.
 * Services log in as the app role, which is neither.
 */
export const tenantIsolation = (
  tableName: string,
  table: { tenantId: AnyPgColumn; businessId: AnyPgColumn },
): PgTableExtraConfigValue[] => [
  index(`${tableName}_tenant_business_idx`).on(
    table.tenantId,
    table.businessId,
  ),
  pgPolicy(TENANT_POLICY_NAME, {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: tenantPredicate,
    withCheck: tenantPredicate,
  }),
];
