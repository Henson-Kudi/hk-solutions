import type { Database } from '@hk/platform/db';
import type { Clock } from '@hk/platform/universal';
import type { IdempotencyKeysTable } from './idempotency';

/**
 * CONTRACT ONLY. Failure-path tests first (plan row 1.4, a money-path row).
 * createIdempotencyCleanup() is not implemented yet: every call throws. The
 * tests in cleanup.spec.ts are marked `it.failing` until the implementation
 * lands, and they are not to be changed to make it pass.
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
  _options: IdempotencyCleanupOptions,
): IdempotencyCleanup => ({
  purge: () => {
    throw new Error(
      'platform/idempotency cleanup is not implemented yet (plan row 1.4).',
    );
  },
});
