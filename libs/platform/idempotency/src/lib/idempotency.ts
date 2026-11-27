import { createHash } from 'node:crypto';
import {
  getTenantContext,
  withSystemTransaction,
  withTenantTransaction,
  type Database,
  type Transaction,
} from '@hk/platform/db';
import { AppError } from '@hk/platform/errors';
import {
  createUuidV7Generator,
  systemClock,
  type Clock,
} from '@hk/platform/universal';
import { and, eq, lte } from 'drizzle-orm';
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
 * A money path (plan row 1.4). The tests in idempotency.spec.ts were written
 * and reviewed before this implementation, and are not to be changed to make
 * code pass. Changes here need Henson's line-by-line review.
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

const IN_PROGRESS = 'IN_PROGRESS';
const COMPLETED = 'COMPLETED';

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const PUBLIC_SCOPE = 'public';

/** 1 to 255 printable ASCII characters, no spaces. */
const VALID_KEY = /^[\x21-\x7e]{1,255}$/;

/** How often a claim is retried when the row it lost to vanished before it could be read. */
const MAX_CLAIM_ATTEMPTS = 3;

const nextId = createUuidV7Generator();

/** JSON text that is the same for equal values, whatever the order of object keys. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** A value as it is after a round trip through JSON, which is how it is stored and replayed. */
const asJson = (value: unknown): unknown =>
  value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);

/**
 * The fingerprint of a call: SHA-256 over the operation and the request in
 * canonical JSON. Two calls are "the same request" exactly when this matches.
 */
export const hashRequest = (operation: string, request: unknown): string =>
  createHash('sha256')
    .update(canonicalJson({ operation, request: asJson(request) }))
    .digest('hex');

export const createIdempotency = (options: IdempotencyOptions): Idempotency => {
  const { database, table } = options;
  const clock = options.clock ?? systemClock;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;

  const execute = async (
    call: IdempotentCall,
    handler: IdempotentHandler,
  ): Promise<IdempotentResult> => {
    if (call.key === undefined) {
      throw new AppError(
        IDEMPOTENCY_ERRORS.KEY_MISSING,
        400,
        'This request needs an Idempotency-Key header.',
      );
    }
    if (!VALID_KEY.test(call.key)) {
      throw new AppError(
        IDEMPOTENCY_ERRORS.KEY_INVALID,
        400,
        'The Idempotency-Key must be 1 to 255 printable ASCII characters without spaces.',
      );
    }

    const key = call.key;
    const tenant = getTenantContext();
    const scope = tenant
      ? `${tenant.tenantId}:${tenant.businessId}`
      : PUBLIC_SCOPE;
    const requestHash = hashRequest(call.operation, call.request);
    const leaseToken = nextId();
    const thisKey = and(eq(table.scope, scope), eq(table.key, key));
    const heldByThisAttempt = and(
      thisKey,
      eq(table.leaseToken, leaseToken),
      eq(table.status, IN_PROGRESS),
    );

    /**
     * Step 1: claim the key, in a statement of its own that commits at once,
     * so that other requests can see the key is taken while the handler runs.
     *
     * The insert wins when the key is new. When the key exists, the update
     * wins only if the key is still IN_PROGRESS and its lease has run out,
     * which means the attempt that held it is presumed dead. A row comes back
     * only when this attempt now holds the key.
     */
    const claim = async (): Promise<boolean> => {
      const now = clock.now();
      const claimed = await database.drizzle
        .insert(table)
        .values({
          id: nextId(),
          scope,
          key,
          operation: call.operation,
          requestHash,
          status: IN_PROGRESS,
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          createdAt: now,
          expiresAt: new Date(now.getTime() + retentionMs),
        })
        .onConflictDoUpdate({
          target: [table.scope, table.key],
          set: {
            operation: call.operation,
            requestHash,
            leaseToken,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            expiresAt: new Date(now.getTime() + retentionMs),
          },
          setWhere: and(
            eq(table.status, IN_PROGRESS),
            lte(table.leaseExpiresAt, now),
          ),
        })
        .returning({ id: table.id });
      return claimed.length > 0;
    };

    /**
     * Step 1b: the key is held by someone else. Decide what that means for
     * this request. Returns undefined when the row has gone in the meantime
     * (its attempt failed and released it), so the claim can be tried again.
     */
    const answerFromExisting = async (): Promise<
      IdempotentResult | undefined
    > => {
      const rows = await database.drizzle
        .select()
        .from(table)
        .where(thisKey)
        .limit(1);
      const existing = rows[0];
      if (!existing) {
        return undefined;
      }
      // Checked first: a different request is wrong whether or not the first
      // one has finished.
      if (existing.requestHash !== requestHash) {
        throw new AppError(
          IDEMPOTENCY_ERRORS.KEY_REUSED,
          422,
          'This Idempotency-Key was already used for a different request.',
        );
      }
      if (existing.status === COMPLETED) {
        return {
          response: {
            status: existing.responseStatus ?? 200,
            body: existing.responseBody ?? null,
          },
          replayed: true,
        };
      }
      throw new AppError(
        IDEMPOTENCY_ERRORS.IN_FLIGHT,
        409,
        'A request with this Idempotency-Key is still being processed.',
        { headers: { 'Retry-After': '1' } },
      );
    };

    let claimed = false;
    for (let attempt = 1; !claimed; attempt += 1) {
      claimed = await claim();
      if (claimed) {
        break;
      }
      const answer = await answerFromExisting();
      if (answer) {
        return answer;
      }
      if (attempt >= MAX_CLAIM_ATTEMPTS) {
        throw new AppError(
          IDEMPOTENCY_ERRORS.IN_FLIGHT,
          409,
          'A request with this Idempotency-Key is still being processed.',
          { headers: { 'Retry-After': '1' } },
        );
      }
    }

    /**
     * Step 2: run the handler, and in the same transaction mark the key
     * COMPLETED with the response. Either both commit or neither does:
     *
     * - the handler throws: everything rolls back, the key is released below;
     * - the process dies after COMMIT: the key is COMPLETED with its response,
     *   so a retry is answered from the store;
     * - this attempt outlived its lease and another took the key: the update
     *   matches no row, LEASE_LOST is thrown, and this transaction, with
     *   whatever the handler did, rolls back.
     */
    const work = async (
      transaction: Transaction,
    ): Promise<IdempotentResponse> => {
      const answered = await handler(transaction);
      const response: IdempotentResponse = {
        status: answered.status,
        body: asJson(answered.body),
      };
      const completed = await transaction
        .update(table)
        .set({
          status: COMPLETED,
          responseStatus: response.status,
          responseBody: response.body,
          completedAt: clock.now(),
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(heldByThisAttempt)
        .returning({ id: table.id });
      if (completed.length === 0) {
        throw new AppError(
          IDEMPOTENCY_ERRORS.LEASE_LOST,
          409,
          'This request took too long and was superseded by a retry.',
        );
      }
      return response;
    };

    try {
      const response = await (tenant
        ? withTenantTransaction(database, work)
        : withSystemTransaction(database, work));
      return { response, replayed: false };
    } catch (error) {
      // Release the key so the caller can retry at once. This only matches
      // while this attempt still holds an unfinished key: not after a commit
      // (the key is COMPLETED), and not after a takeover (the token differs).
      try {
        await database.drizzle.delete(table).where(heldByThisAttempt);
      } catch {
        // The lease will expire and free the key. The original error matters more.
      }
      throw error;
    }
  };

  return { execute };
};
