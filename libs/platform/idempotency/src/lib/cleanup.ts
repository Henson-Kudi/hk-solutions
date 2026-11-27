import type { Database } from '@hk/platform/db';
import { systemClock, type Clock } from '@hk/platform/universal';
import { and, asc, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { IdempotencyKeysTable } from './idempotency';

/**
 * A money path (plan row 1.4). The tests in cleanup.spec.ts were written and
 * reviewed before this implementation, and are not to be changed to make code
 * pass. Changes here need Henson's line-by-line review.
 */

export interface IdempotencyCleanupOptions {
  database: Database;
  table: IdempotencyKeysTable;
  /** Defaults to the system clock. */
  clock?: Clock;
  /** Rows deleted per call, so one call never holds a long lock. Defaults to 1000. */
  batchSize?: number;
}

export interface IdempotencyCleanup {
  /**
   * Deletes keys whose `expires_at` has passed, oldest first, up to the batch
   * size, and returns how many it deleted. Call it again while it returns a
   * full batch.
   *
   * A key is removed only when replaying it is no longer promised. After
   * that, the same key value counts as never used.
   *
   * A key that is still IN_PROGRESS with a live lease is never deleted, even
   * if its `expires_at` has passed: deleting it would let a second request
   * run alongside the first.
   */
  purge(): Promise<number>;
}

export const createIdempotencyCleanup = (
  options: IdempotencyCleanupOptions,
): IdempotencyCleanup => {
  const { database, table } = options;
  const clock = options.clock ?? systemClock;
  const batchSize = options.batchSize ?? 1_000;

  return {
    purge: async () => {
      const now = clock.now();
      // One statement. The inner query picks the batch and locks it, skipping
      // rows another cleanup run already holds, so two runs never wait on
      // each other. A key that is IN_PROGRESS with a lease still in the
      // future is left alone whatever its expires_at says.
      const batch = database.drizzle
        .select({ id: table.id })
        .from(table)
        .where(
          and(
            lte(table.expiresAt, now),
            or(
              ne(table.status, 'IN_PROGRESS'),
              isNull(table.leaseExpiresAt),
              lte(table.leaseExpiresAt, now),
            ),
          ),
        )
        .orderBy(asc(table.expiresAt), asc(table.id))
        .limit(batchSize)
        .for('update', { skipLocked: true });

      const deleted = await database.drizzle
        .delete(table)
        .where(inArray(table.id, batch))
        .returning({ id: table.id });
      return deleted.length;
    },
  };
};
