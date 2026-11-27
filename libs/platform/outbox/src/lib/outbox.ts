import type { Database, Transaction } from '@hk/platform/db';
import type { Logger } from '@hk/platform/logger';
import type { RedisClient } from '@hk/platform/redis';
import type { Clock } from '@hk/platform/universal';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
  type PgSchema,
} from 'drizzle-orm/pg-core';

/**
 * CONTRACT ONLY. This file fixes the public shape of platform/outbox so that
 * its failure-path tests can be written and reviewed first (plan row 1.4, a
 * money-path row). Nothing below is implemented yet: every call throws. The
 * tests in outbox.spec.ts are marked `it.failing` until the implementation
 * lands, and they are not to be changed to make it pass.
 */

/**
 * One row per event waiting to be published. Each service has this table in
 * its own schema:
 *
 *   export const outbox = outboxTable(sales);
 *
 * The table is not under the tenant row-level-security policy: the relay
 * reads the events of every business in one pass. tenant_id and business_id
 * are plain data here, copied from the tenant context so the consumer can
 * restore it.
 */
export const outboxTable = (schema: PgSchema) =>
  schema.table(
    'outbox',
    {
      /** A UUID v7. It is the event id consumers deduplicate on, and the queue job id. */
      id: uuid('id').primaryKey(),
      /** For example "sales.invoice.issued". */
      topic: text('topic').notNull(),
      payload: jsonb('payload').notNull(),
      tenantId: uuid('tenant_id'),
      businessId: uuid('business_id'),
      /** Trace and request context to carry across the queue. */
      headers: jsonb('headers').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
      /** Null until the relay has handed the event to the queue. */
      publishedAt: timestamp('published_at', { withTimezone: true }),
      attempts: integer('attempts').notNull().default(0),
      /** The relay skips the row until this instant. Moves out after each failed attempt. */
      nextAttemptAt: timestamp('next_attempt_at', {
        withTimezone: true,
      }).notNull(),
    },
    (table) => [
      index('outbox_pending_idx')
        .on(table.nextAttemptAt, table.id)
        .where(sql`${table.publishedAt} is null`),
    ],
  );

export type OutboxTable = ReturnType<typeof outboxTable>;

/** An event as the relay hands it to the publisher, and as a consumer receives it. */
export interface OutboxEvent<Payload = unknown> {
  id: string;
  topic: string;
  /** Plain JSON data. Money arrives as decimal strings. */
  payload: Payload;
  tenantId: string | null;
  businessId: string | null;
  headers: Record<string, string>;
  /** ISO 8601 instant. */
  occurredAt: string;
}

export interface NewOutboxEvent<Payload = unknown> {
  /** Defaults to a new UUID v7. */
  id?: string;
  topic: string;
  payload: Payload;
  headers?: Record<string, string>;
}

export interface OutboxOptions {
  table: OutboxTable;
  clock?: Clock;
}

export interface Outbox {
  /**
   * Records an event in the given transaction. It is published only if, and
   * only after, that transaction commits: the state change and its
   * announcement cannot come apart.
   *
   * The transaction is a parameter on purpose. There is no way to append an
   * event outside one. The tenant and business are taken from the tenant
   * context when one is active.
   */
  append<Payload>(
    transaction: Transaction,
    event: NewOutboxEvent<Payload>,
  ): Promise<OutboxEvent<Payload>>;
}

/** Hands one event to the transport. Must be safe to call twice for the same event id. */
export type Publish = (event: OutboxEvent) => Promise<void>;

export interface OutboxRelayOptions {
  database: Database;
  table: OutboxTable;
  publish: Publish;
  logger: Logger;
  clock?: Clock;
  /** Events taken per pass. Defaults to 100. */
  batchSize?: number;
  /** Wait after the first failed attempt; doubles each time up to maxRetryDelayMs. Defaults to 1000. */
  retryDelayMs?: number;
  /** Defaults to 300000 (5 minutes). */
  maxRetryDelayMs?: number;
}

export interface RelayPass {
  published: number;
  failed: number;
}

export interface OutboxRelay {
  /**
   * One pass: takes due, unpublished events in the order they were written,
   * publishes each, and marks the ones that succeeded.
   *
   * Delivery is at least once. If the process stops after publishing and
   * before marking, the event is published again, with the same id. A failed
   * publish leaves the event pending with a later nextAttemptAt, and does not
   * stop the events behind it. Several relays may run at the same time
   * without publishing the same event twice.
   */
  drain(): Promise<RelayPass>;
  /** Calls drain() repeatedly, pausing `idleMs` (default 1000) when a pass found nothing. */
  start(idleMs?: number): void;
  /** Stops after the pass in progress. */
  stop(): Promise<void>;
}

export interface QueuePublisherOptions {
  /** A connection created with purpose "queue". */
  connection: RedisClient;
}

export interface QueuePublisher {
  /**
   * Publishes to the BullMQ queue named after the event's topic, with the
   * event id as the job id, so a second publish of the same event is ignored
   * while the first is still known to the queue.
   */
  publish: Publish;
  close(): Promise<void>;
}

const notImplemented = (): never => {
  throw new Error('platform/outbox is not implemented yet (plan row 1.4).');
};

export const createOutbox = (_options: OutboxOptions): Outbox => ({
  append: notImplemented,
});

export const createOutboxRelay = (
  _options: OutboxRelayOptions,
): OutboxRelay => ({
  drain: notImplemented,
  start: notImplemented,
  stop: notImplemented,
});

export const createQueuePublisher = (
  _options: QueuePublisherOptions,
): QueuePublisher => ({
  publish: notImplemented,
  close: notImplemented,
});
