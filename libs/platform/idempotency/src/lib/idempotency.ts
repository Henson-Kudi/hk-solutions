import type { Database, Transaction } from '@hk/platform/db';
import type { Clock } from '@hk/platform/universal';
import {
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgSchema,
} from 'drizzle-orm/pg-core';

/**
 * CONTRACT ONLY. This file fixes the public shape of platform/idempotency so
 * that its failure-path tests can be written and reviewed first (plan row
 * 1.4, a money-path row). createIdempotency() is not implemented yet: every
 * call throws. The tests in idempotency.spec.ts are marked `it.failing` until
 * the implementation lands, and they are not to be changed to make it pass.
 */

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** Error codes, all thrown as AppError from @hk/platform/errors. */
export const IDEMPOTENCY_ERRORS = {
  /** 400. A mutating request arrived without a key. */
  KEY_MISSING: 'IDEMPOTENCY_KEY_MISSING',
  /** 400. The key is empty, longer than 255 characters, or not printable ASCII. */
  KEY_INVALID: 'IDEMPOTENCY_KEY_INVALID',
  /** 409. Another request with this key is still being handled. */
  IN_FLIGHT: 'IDEMPOTENCY_IN_FLIGHT',
  /** 422. The key was already used for a different operation or a different request. */
  KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** 409. This attempt outlived its lease and another attempt took the key over. */
  LEASE_LOST: 'IDEMPOTENCY_LEASE_LOST',
} as const;

/**
 * One row per key. Each service has this table in its own schema:
 *
 *   export const idempotencyKeys = idempotencyKeysTable(sales);
 *
 * `scope` separates callers that must not share keys: the tenant and business
 * of the request, or "public" for a request made before anyone is signed in.
 * The table is not under the tenant row-level-security policy, because a key
 * must be found before a tenant transaction can start, and because public
 * requests have no tenant.
 */
export const idempotencyKeysTable = (schema: PgSchema) =>
  schema.table(
    'idempotency_keys',
    {
      id: uuid('id').primaryKey(),
      scope: text('scope').notNull(),
      key: text('key').notNull(),
      /** What the key was first used for, for example "POST /sales/invoices". */
      operation: text('operation').notNull(),
      /** Hash of the operation and the request. Never the request itself. */
      requestHash: text('request_hash').notNull(),
      /** IN_PROGRESS or COMPLETED. */
      status: text('status').notNull(),
      /** Identifies the attempt that holds an IN_PROGRESS key. */
      leaseToken: uuid('lease_token'),
      /** After this instant an IN_PROGRESS key may be taken over. */
      leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
      responseStatus: integer('response_status'),
      responseBody: jsonb('response_body'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      completedAt: timestamp('completed_at', { withTimezone: true }),
      /** A cleanup job deletes the row after this instant. */
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (table) => [
      uniqueIndex('idempotency_keys_scope_key_uq').on(table.scope, table.key),
      index('idempotency_keys_expires_idx').on(table.expiresAt),
    ],
  );

export type IdempotencyKeysTable = ReturnType<typeof idempotencyKeysTable>;

/** What the handler answered. Stored with the key and returned again on a replay. */
export interface IdempotentResponse {
  status: number;
  /** Must survive JSON: plain data, with money as decimal strings. */
  body: unknown;
}

export interface IdempotentCall {
  /** The Idempotency-Key header, or undefined when the caller sent none. */
  key: string | undefined;
  /** Names the action: "POST /sales/invoices", or "sales:invoice:<id>:post" for an internal step. */
  operation: string;
  /** Everything that defines the request: params, query and body. Only its hash is stored. */
  request: unknown;
}

export interface IdempotentResult {
  response: IdempotentResponse;
  /** True when the response came from the store and the handler did not run. */
  replayed: boolean;
}

/**
 * Runs inside the transaction that also records the key as completed, so the
 * business change and "this key is done" commit together or not at all. Write
 * through the given transaction (repositories pick it up by themselves).
 */
export type IdempotentHandler = (
  transaction: Transaction,
) => Promise<IdempotentResponse>;

export interface IdempotencyOptions {
  database: Database;
  table: IdempotencyKeysTable;
  /** Defaults to the system clock. */
  clock?: Clock;
  /**
   * How long an attempt may hold a key before another attempt may take it
   * over. Defaults to 60000. It must be longer than the slowest handler.
   */
  leaseMs?: number;
  /** How long a completed key is kept for replays. Defaults to 24 hours. */
  retentionMs?: number;
}

export interface Idempotency {
  /**
   * Executes `handler` at most once per key.
   *
   * - No key: throws KEY_MISSING (400). The handler does not run.
   * - First use: runs the handler in a transaction (a tenant transaction when
   *   a tenant context is active, otherwise a system one) and stores its
   *   response in that same transaction.
   * - Same key, same request, completed: returns the stored response with
   *   `replayed: true`. The handler does not run.
   * - Same key, still running: throws IN_FLIGHT (409).
   * - Same key, different operation or request: throws KEY_REUSED (422).
   * - The handler throws: its transaction rolls back, nothing is stored, and
   *   the same key may be used again to retry.
   */
  execute(
    call: IdempotentCall,
    handler: IdempotentHandler,
  ): Promise<IdempotentResult>;
}

export const createIdempotency = (
  _options: IdempotencyOptions,
): Idempotency => ({
  execute: () => {
    throw new Error(
      'platform/idempotency is not implemented yet (plan row 1.4).',
    );
  },
});
