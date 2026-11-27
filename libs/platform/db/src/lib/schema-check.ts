import { is, sql } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { TENANT_POLICY_NAME } from './columns';
import type { Transaction } from './database';

export interface SchemaViolation {
  /** "schema.table". */
  table: string;
  problem: string;
}

export interface SchemaCheckOptions {
  /**
   * Tables that are deliberately not tenant-scoped, as "schema.table":
   * reference data such as core.countries, and platform tables such as the
   * outbox. Keep this list short and explain each entry where it is declared.
   */
  exempt?: readonly string[];
}

const REQUIRED_COLUMNS = ['tenant_id', 'business_id', 'version'];

/** Every Drizzle table among a module's exports. Pass `import * as schema from './schema'`. */
export const tablesOf = (exports: Record<string, unknown>): PgTable[] =>
  Object.values(exports).filter((value): value is PgTable =>
    is(value, PgTable),
  );

/**
 * Checks Drizzle table definitions against the tenancy rules. An empty result
 * means every table complies.
 *
 * Each service has a test that calls this with all of its tables, so a table
 * added without tenant columns, without the index or without the policy fails
 * CI before a migration is ever written.
 *
 * A table complies when it has:
 * - tenant_id and business_id, both uuid and NOT NULL, and a version column;
 * - an index whose first two columns are tenant_id and business_id;
 * - the tenant_isolation policy with both USING and WITH CHECK.
 */
export const findTenantSchemaViolations = (
  tables: readonly PgTable[],
  options: SchemaCheckOptions = {},
): SchemaViolation[] => {
  const exempt = options.exempt ?? [];
  const violations: SchemaViolation[] = [];

  for (const table of tables) {
    const config = getTableConfig(table);
    const name = `${config.schema ?? 'public'}.${config.name}`;
    if (exempt.includes(name)) {
      continue;
    }
    const report = (problem: string) =>
      violations.push({ table: name, problem });

    if (config.schema === undefined) {
      report('is in the public schema; a table belongs to its service schema');
    }

    for (const columnName of REQUIRED_COLUMNS) {
      const column = config.columns.find(
        (candidate) => candidate.name === columnName,
      );
      if (!column) {
        report(`has no ${columnName} column`);
      } else if (columnName !== 'version') {
        if (column.getSQLType() !== 'uuid') report(`${columnName} is not uuid`);
        if (!column.notNull) report(`${columnName} is nullable`);
      }
    }

    const hasIndex = config.indexes.some((candidate) => {
      const [first, second] = candidate.config.columns.map((column) =>
        'name' in column ? column.name : undefined,
      );
      return first === 'tenant_id' && second === 'business_id';
    });
    if (!hasIndex) {
      report('has no index starting with (tenant_id, business_id)');
    }

    const policy = config.policies.find(
      (candidate) => candidate.name === TENANT_POLICY_NAME,
    );
    if (!policy) {
      report(`has no ${TENANT_POLICY_NAME} policy`);
    } else {
      if (!policy.using) report(`${TENANT_POLICY_NAME} has no USING clause`);
      if (!policy.withCheck) {
        report(`${TENANT_POLICY_NAME} has no WITH CHECK clause`);
      }
      if (policy.for !== undefined && policy.for !== 'all') {
        report(`${TENANT_POLICY_NAME} does not cover all commands`);
      }
    }
  }
  return violations;
};

interface CatalogRow extends Record<string, unknown> {
  table_name: string;
  rls_enabled: boolean;
  has_policy: boolean;
  has_tenant_id: boolean;
  has_business_id: boolean;
}

/**
 * The same question asked of the database itself: does every table that
 * exists in `schema` have row-level security switched on, the tenant policy
 * and the tenant columns?
 *
 * This catches what the Drizzle check cannot: a migration that was never
 * generated or never applied, and a policy dropped by hand. Run it after
 * migrations, in the migration job and in each service's integration tests.
 *
 * Tables whose name starts with "__" (the migrations table) are skipped.
 */
export const findTenantCatalogViolations = async (
  transaction: Transaction,
  schema: string,
  options: SchemaCheckOptions = {},
): Promise<SchemaViolation[]> => {
  const exempt = options.exempt ?? [];
  const result = await transaction.execute<CatalogRow>(sql`
    select
      c.relname as table_name,
      c.relrowsecurity as rls_enabled,
      exists (
        select 1 from pg_policy p
        where p.polrelid = c.oid
          and p.polname = ${TENANT_POLICY_NAME}
          and p.polqual is not null
          and p.polwithcheck is not null
      ) as has_policy,
      exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'tenant_id'
          and a.attnotnull and not a.attisdropped
      ) as has_tenant_id,
      exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'business_id'
          and a.attnotnull and not a.attisdropped
      ) as has_business_id
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema}
      and c.relkind in ('r', 'p')
      and c.relname not like '\\_\\_%'
    order by c.relname
  `);

  const violations: SchemaViolation[] = [];
  for (const row of result.rows) {
    const name = `${schema}.${row.table_name}`;
    if (exempt.includes(name)) {
      continue;
    }
    const report = (problem: string) =>
      violations.push({ table: name, problem });
    if (!row.has_tenant_id) report('has no NOT NULL tenant_id column');
    if (!row.has_business_id) report('has no NOT NULL business_id column');
    if (!row.rls_enabled) report('does not have row-level security enabled');
    if (!row.has_policy) report(`has no ${TENANT_POLICY_NAME} policy`);
  }
  return violations;
};
