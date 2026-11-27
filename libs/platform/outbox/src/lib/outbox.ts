import {
  getTenantContext,
  type Database,
  type Transaction,
} from '@hk/platform/db';
import type { Logger } from '@hk/platform/logger';
import { createQueue, type JobQueue } from '@hk/platform/queue';
import type { RedisClient } from '@hk/platform/redis';
import {
  createUuidV7Generator,
  systemClock,
  type Clock,
} from '@hk/platform/universal';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
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
 * A money path (plan row 1.4). The tests in outbox.spec.ts were written and
 * reviewed before this implementation, and are not to be changed to make code
 * pass. Changes here need Henson's line-by-line review.
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

const nextId = createUuidV7Generator();

/** A value as it is after a round trip through JSON, which is how it is stored and published. */
const asJson = <Value>(value: Value): Value =>
  JSON.parse(JSON.stringify(value)) as Value;

export const createOutbox = (options: OutboxOptions): Outbox => {
  const { table } = options;
  const clock = options.clock ?? systemClock;

  return {
    append: async (transaction, event) => {
      const tenant = getTenantContext();
      const occurredAt = clock.now();
      const stored = {
        id: event.id ?? nextId(),
        topic: event.topic,
        payload: asJson(event.payload),
        tenantId: tenant?.tenantId ?? null,
        businessId: tenant?.businessId ?? null,
        headers: { ...event.headers },
      };
      await transaction.insert(table).values({
        ...stored,
        occurredAt,
        // Due at once: the relay picks it up on its next pass after commit.
        nextAttemptAt: occurredAt,
      });
      return { ...stored, occurredAt: occurredAt.toISOString() };
    },
  };
};

export const createOutboxRelay = (options: OutboxRelayOptions): OutboxRelay => {
  const { database, table, publish, logger } = options;
  const clock = options.clock ?? systemClock;
  const batchSize = options.batchSize ?? 100;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 300_000;

  /**
   * One pass, in one transaction.
   *
   * The rows are selected FOR UPDATE SKIP LOCKED. The lock is what stops a
   * second relay from taking the same events: it skips them and takes the
   * next ones. The lock is held until this pass commits, so publishing
   * happens inside the transaction. That is a deliberate exception to "no
   * remote calls in a transaction": the call is one enqueue per event, the
   * batch is bounded, and without the lock two relays would both publish.
   *
   * The transaction is opened on the Drizzle handle directly and not through
   * withSystemTransaction, so that `publish` does not run inside this
   * transaction's context and cannot join it by accident.
   */
  const drain = async (): Promise<RelayPass> => {
    const pass: RelayPass = { published: 0, failed: 0 };

    await database.drizzle.transaction(async (transaction) => {
      const now = clock.now();
      const due = await transaction
        .select()
        .from(table)
        .where(and(isNull(table.publishedAt), lte(table.nextAttemptAt, now)))
        .orderBy(asc(table.occurredAt), asc(table.id))
        .limit(batchSize)
        .for('update', { skipLocked: true });

      for (const row of due) {
        const event: OutboxEvent = {
          id: row.id,
          topic: row.topic,
          payload: row.payload,
          tenantId: row.tenantId,
          businessId: row.businessId,
          headers: row.headers as Record<string, string>,
          occurredAt: row.occurredAt.toISOString(),
        };
        try {
          await publish(event);
        } catch (err) {
          // Stay pending, and wait longer after each failure so a broken
          // transport is not hammered: retryDelay, then double, up to the cap.
          const delay = Math.min(
            retryDelayMs * 2 ** row.attempts,
            maxRetryDelayMs,
          );
          await transaction
            .update(table)
            .set({
              attempts: row.attempts + 1,
              nextAttemptAt: new Date(now.getTime() + delay),
            })
            .where(eq(table.id, row.id));
          pass.failed += 1;
          logger.warn('outbox publish failed', {
            eventId: row.id,
            topic: row.topic,
            attempts: row.attempts + 1,
            err,
          });
          continue;
        }
        // If the process stops between the publish above and the commit of
        // this update, the event is published again on the next pass, with
        // the same id. Consumers deduplicate on it (platform/inbox).
        await transaction
          .update(table)
          .set({ attempts: row.attempts + 1, publishedAt: now })
          .where(eq(table.id, row.id));
        pass.published += 1;
      }
    });
    return pass;
  };

  let running = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  const pause = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  return {
    drain,
    start: (idleMs = 1_000) => {
      if (running) {
        return;
      }
      running = true;
      loop = (async () => {
        while (running) {
          let idle = true;
          try {
            const pass = await drain();
            idle = pass.published + pass.failed === 0;
          } catch (err) {
            // For example the database is away. Keep the relay alive.
            logger.error('outbox relay pass failed', { err });
          }
          if (running && idle) {
            await pause(idleMs);
          }
        }
      })();
    },
    stop: async () => {
      running = false;
      wake?.();
      await loop;
      loop = undefined;
    },
  };
};

export const createQueuePublisher = (
  options: QueuePublisherOptions,
): QueuePublisher => {
  const queues = new Map<string, JobQueue<OutboxEvent>>();

  const queueFor = (topic: string): JobQueue<OutboxEvent> => {
    let queue = queues.get(topic);
    if (!queue) {
      queue = createQueue<OutboxEvent>({
        name: topic,
        connection: options.connection,
      });
      queues.set(topic, queue);
    }
    return queue;
  };

  return {
    publish: async (event) => {
      await queueFor(event.topic).enqueue(event.topic, event, {
        jobId: event.id,
      });
    },
    close: async () => {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
      queues.clear();
    },
  };
};
