import { tenantColumns, tenantIsolation } from '@hk/platform/db';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgSchema,
} from 'drizzle-orm/pg-core';

/**
 * The access tables: the roles and memberships of each business, and the
 * directory of who belongs to which business.
 *
 *   export const access = accessTables(core);
 *
 * Needs Henson's line-by-line review, like every table definition that
 * becomes a migration.
 *
 * `roles` and `memberships` ARE tenant-scoped: they have the tenant columns
 * and the row-level security policy, and are reached through
 * ScopedRepository. What a person may do in a business, and who works
 * there, is that business's data.
 *
 * `user_businesses` is NOT, on purpose, and is the only one. It answers the
 * question that has to be asked before a business is chosen: "which
 * businesses may this person enter?". Row-level security hides every
 * business's rows until one is chosen, so that question cannot be answered
 * from behind it. The table therefore holds the least that answers it: the
 * person, the business, its tenant, and whether the membership is active.
 * No role, no permission, no branch. It is written in the same transaction
 * as the membership it mirrors, and it only ever says where to look: the
 * membership itself decides.
 */
export const accessTables = (schema: PgSchema) => {
  const roles = schema.table(
    'roles',
    {
      ...tenantColumns,
      /** The built-in role this is the business's copy of. Null for a custom role. */
      key: text('key'),
      name: text('name').notNull(),
      /** "resource:action" strings from the permission registry. Ignored for the owner. */
      permissions: text('permissions').array().notNull(),
    },
    (table) => [
      // One copy of each built-in role in a business.
      uniqueIndex('roles_business_key_uq')
        .on(table.businessId, table.key)
        .where(sql`${table.key} is not null`),
      // No two roles of a business share a name, whatever the case.
      uniqueIndex('roles_business_name_uq').on(
        table.businessId,
        sql`lower(${table.name})`,
      ),
      check(
        'roles_key',
        sql`${table.key} is null or ${table.key} in ('owner', 'manager', 'accountant', 'cashier', 'storekeeper', 'hr_officer', 'viewer', 'external_accountant')`,
      ),
      ...tenantIsolation('roles', table),
    ],
  );

  const memberships = schema.table(
    'memberships',
    {
      ...tenantColumns,
      /**
       * The person. Not a foreign key into the users table: that table is
       * global, and a tenant-scoped row should not hold a lock on it.
       */
      userId: uuid('user_id').notNull(),
      /**
       * The role held. Not a foreign key: a removed membership keeps the id
       * of a role that may since have been deleted. A member whose role is
       * gone is refused everywhere.
       */
      roleId: uuid('role_id').notNull(),
      /** The branches the person may work in. Null means every branch. */
      branchIds: uuid('branch_ids').array(),
      /** "active", "suspended" or "removed". */
      status: text('status').notNull(),
      joinedAt: timestamp('joined_at', {
        withTimezone: true,
        precision: 3,
      }).notNull(),
    },
    (table) => [
      // A person has one membership in a business, whatever its status.
      uniqueIndex('memberships_business_user_uq').on(
        table.businessId,
        table.userId,
      ),
      index('memberships_business_role_idx').on(table.businessId, table.roleId),
      check(
        'memberships_status',
        sql`${table.status} in ('active', 'suspended', 'removed')`,
      ),
      // "No branch at all" is not a limit; that is what suspending is for.
      check(
        'memberships_branches',
        sql`${table.branchIds} is null or cardinality(${table.branchIds}) > 0`,
      ),
      ...tenantIsolation('memberships', table),
    ],
  );

  const userBusinesses = schema.table(
    'user_businesses',
    {
      userId: uuid('user_id').notNull(),
      businessId: uuid('business_id').notNull(),
      tenantId: uuid('tenant_id').notNull(),
      /** True while the membership is active. */
      active: boolean('active').notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'user_businesses_pk',
        columns: [table.userId, table.businessId],
      }),
    ],
  );

  return { roles, memberships, userBusinesses };
};

export type AccessTables = ReturnType<typeof accessTables>;

/**
 * The one access table that is global, as a "table" name for the tenancy
 * schema check's exempt list. `roles` and `memberships` are not on it and
 * must never be.
 */
export const ACCESS_GLOBAL_TABLES = ['user_businesses'] as const;
