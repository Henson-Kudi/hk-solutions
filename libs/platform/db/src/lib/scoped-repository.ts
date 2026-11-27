import { DomainError } from '@hk/platform/universal';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Transaction } from './database';
import { requireTenantContext } from './tenant-context';
import { requireTenantTransaction } from './transaction';

/** A table that starts with tenantColumns. */
export type TenantTable = PgTable & {
  id: AnyPgColumn;
  tenantId: AnyPgColumn;
  businessId: AnyPgColumn;
  createdBy: AnyPgColumn;
  updatedAt: AnyPgColumn;
  version: AnyPgColumn;
};

/** Columns the repository fills in. A caller cannot set them. */
type Stamped =
  | 'tenantId'
  | 'businessId'
  | 'createdBy'
  | 'createdAt'
  | 'updatedAt'
  | 'version';

const STAMPED_KEYS: readonly string[] = [
  'tenantId',
  'businessId',
  'createdBy',
  'createdAt',
  'updatedAt',
  'version',
];

export type Row<Table extends TenantTable> = Table['$inferSelect'];

/** What a caller provides to insert a row: its id and its own columns. */
export type NewRow<Table extends TenantTable> = Omit<
  Table['$inferInsert'],
  Stamped
>;

/** The columns an update may change. */
export type RowPatch<Table extends TenantTable> = Partial<
  Omit<Table['$inferInsert'], Stamped | 'id'>
>;

const without = (
  values: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(values).filter(([key]) => !keys.includes(key)),
  );

/**
 * The base of every repository over a business table.
 *
 * It is the first of two layers that keep businesses apart. Every query it
 * builds is filtered by the tenant and business of the tenant context, and
 * every insert is stamped with them. The second layer is the row-level
 * security policy in the database, which holds even for SQL this class did
 * not build.
 *
 * Its methods throw when there is no tenant context, or when they are called
 * outside withTenantTransaction.
 *
 * Subclasses add methods in the language of their aggregate and implement an
 * application-layer port. The building blocks here are protected so that a
 * use case can only do what its port offers.
 */
export abstract class ScopedRepository<Table extends TenantTable> {
  protected constructor(protected readonly table: Table) {}

  /** The open tenant transaction. Use it for queries the building blocks do not cover, with scope(). */
  protected get transaction(): Transaction {
    return requireTenantTransaction();
  }

  /**
   * The tenant and business filter, combined with `condition` when given.
   * Every hand-written query on this table must use it in its WHERE clause.
   */
  protected scope(condition?: SQL): SQL {
    const context = requireTenantContext();
    return and(
      eq(this.table.tenantId, context.tenantId),
      eq(this.table.businessId, context.businessId),
      condition,
    ) as SQL;
  }

  protected async findById(id: string): Promise<Row<Table> | undefined> {
    const rows = await this.find(eq(this.table.id, id), { limit: 1 });
    return rows[0];
  }

  protected async find(
    condition?: SQL,
    options: { limit?: number } = {},
  ): Promise<Row<Table>[]> {
    const where = this.scope(condition);
    const query = this.transaction
      .select()
      .from(this.table as PgTable)
      .where(where);
    const rows = await (options.limit === undefined
      ? query
      : query.limit(options.limit));
    return rows as Row<Table>[];
  }

  /**
   * Inserts a row for the current business. The tenant, business and creating
   * user come from the tenant context, never from the caller.
   */
  protected async insert(values: NewRow<Table>): Promise<Row<Table>> {
    const context = requireTenantContext();
    const rows = await this.transaction
      .insert(this.table as PgTable)
      .values({
        ...without(values as Record<string, unknown>, STAMPED_KEYS),
        tenantId: context.tenantId,
        businessId: context.businessId,
        createdBy: context.userId ?? null,
      } as never)
      .returning();
    return rows[0] as Row<Table>;
  }

  /**
   * Changes a row, but only if it is still at `expectedVersion`, and moves it
   * to the next version.
   *
   * Throws ROW_STALE_VERSION (a conflict) when someone else changed the row
   * first, and ROW_NOT_FOUND when the current business has no such row.
   */
  protected async update(
    id: string,
    expectedVersion: number,
    patch: RowPatch<Table>,
  ): Promise<Row<Table>> {
    const rows = await this.transaction
      .update(this.table as PgTable)
      .set({
        ...without(patch as Record<string, unknown>, [...STAMPED_KEYS, 'id']),
        version: sql`${this.table.version} + 1`,
        updatedAt: sql`now()`,
      } as never)
      .where(
        this.scope(
          and(eq(this.table.id, id), eq(this.table.version, expectedVersion)),
        ),
      )
      .returning();

    const updated = rows[0] as Row<Table> | undefined;
    if (updated) {
      return updated;
    }
    const current = (await this.findById(id)) as
      | { version: number }
      | undefined;
    if (!current) {
      throw new DomainError('ROW_NOT_FOUND', 'The record was not found.', {
        kind: 'not-found',
      });
    }
    throw new DomainError(
      'ROW_STALE_VERSION',
      'The record was changed by someone else. Reload it and try again.',
      {
        kind: 'conflict',
        details: { expectedVersion, currentVersion: current.version },
      },
    );
  }

  /** Deletes a row of the current business. Returns false when there was none. */
  protected async delete(id: string): Promise<boolean> {
    const rows = await this.transaction
      .delete(this.table as PgTable)
      .where(this.scope(eq(this.table.id, id)))
      .returning({ id: this.table.id });
    return rows.length > 0;
  }
}
