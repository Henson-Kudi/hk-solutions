import { DomainError, systemClock, type Clock } from '@hk/platform/universal';

/** Whose data a piece of work may touch. The universal counterpart of platform/db's TenantContext. */
export interface TenantScope {
  readonly tenantId: string;
  readonly businessId: string;
  readonly userId?: string;
}

/** The columns every business row has, whatever stores it. */
export interface StoredRow {
  id: string;
  tenantId: string;
  businessId: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/**
 * The smallest repository port over one kind of business row, already bound
 * to one business. It is the shape platform/db's ScopedRepository offers on
 * PostgreSQL, and what an infra-sqlite repository offers on a device.
 *
 * Every adapter of it must pass scopedStoreConformance (see conformance.ts):
 * that is how the same use case can run on the server, on SQLite and in
 * memory with identical results.
 */
export interface ScopedStore<Data extends object> {
  /** The tenant, business, creating user and version 1 are stamped by the store. */
  insert(values: { id: string } & Data): Promise<StoredRow & Data>;
  findById(id: string): Promise<(StoredRow & Data) | undefined>;
  /** Every row of this business, oldest first. */
  list(): Promise<(StoredRow & Data)[]>;
  /**
   * Changes a row only if it is still at `expectedVersion`. Throws
   * ROW_STALE_VERSION (a conflict) when it is not, and ROW_NOT_FOUND when
   * this business has no such row.
   */
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<Data>,
  ): Promise<StoredRow & Data>;
  /** False when this business has no such row. */
  delete(id: string): Promise<boolean>;
}

const STAMPED: readonly string[] = [
  'id',
  'tenantId',
  'businessId',
  'createdBy',
  'createdAt',
  'updatedAt',
  'version',
];

const withoutStamped = (values: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(values).filter(([key]) => !STAMPED.includes(key)),
  );

/**
 * A ScopedStore that keeps its rows in memory. For use-case tests, and as the
 * reference the conformance suite was written against.
 *
 * One instance holds the rows of every business, like a table.
 * `for(scope)` gives the view of one business.
 */
export class InMemoryScopedStore<Data extends object> {
  private readonly rows = new Map<string, StoredRow & Data>();

  constructor(private readonly clock: Clock = systemClock) {}

  for(scope: TenantScope): ScopedStore<Data> {
    const owns = (row: StoredRow): boolean =>
      row.tenantId === scope.tenantId && row.businessId === scope.businessId;
    // Rows are copied on the way in and out, as a database would.
    const copy = (row: StoredRow & Data): StoredRow & Data => ({
      ...row,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    });
    const find = (id: string): (StoredRow & Data) | undefined => {
      const row = this.rows.get(id);
      return row && owns(row) ? row : undefined;
    };

    return {
      insert: async (values) => {
        if (this.rows.has(values.id)) {
          throw new DomainError(
            'ROW_ALREADY_EXISTS',
            'The record already exists.',
            {
              kind: 'conflict',
            },
          );
        }
        const now = this.clock.now();
        const row = {
          ...(withoutStamped(values) as Data),
          id: values.id,
          tenantId: scope.tenantId,
          businessId: scope.businessId,
          createdBy: scope.userId ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        this.rows.set(row.id, row);
        return copy(row);
      },
      findById: async (id) => {
        const row = find(id);
        return row ? copy(row) : undefined;
      },
      list: async () => [...this.rows.values()].filter(owns).map(copy),
      update: async (id, expectedVersion, patch) => {
        const row = find(id);
        if (!row) {
          throw new DomainError('ROW_NOT_FOUND', 'The record was not found.', {
            kind: 'not-found',
          });
        }
        if (row.version !== expectedVersion) {
          throw new DomainError(
            'ROW_STALE_VERSION',
            'The record was changed by someone else. Reload it and try again.',
            {
              kind: 'conflict',
              details: { expectedVersion, currentVersion: row.version },
            },
          );
        }
        const updated = {
          ...row,
          ...(withoutStamped(patch) as Partial<Data>),
          version: row.version + 1,
          updatedAt: this.clock.now(),
        };
        this.rows.set(id, updated);
        return copy(updated);
      },
      delete: async (id) => {
        if (!find(id)) {
          return false;
        }
        this.rows.delete(id);
        return true;
      },
    };
  }
}

/**
 * Ids that are valid UUID v7 values and come out in a fixed, readable order:
 * …0001, …0002, … For tests that want predictable ids. `seed` keeps two
 * generators in one test apart.
 */
export const sequentialIds = (seed = 0): (() => string) => {
  let counter = 0;
  return () => {
    counter += 1;
    const high = seed.toString(16).padStart(8, '0').slice(-8);
    const low = counter.toString(16).padStart(12, '0').slice(-12);
    return `${high}-0000-7000-8000-${low}`;
  };
};
