import type { Transaction } from '@hk/platform/db';
import {
  primaryKey,
  text,
  timestamp,
  uuid,
  type PgSchema,
} from 'drizzle-orm/pg-core';

/**
 * A money path (plan row 1.4). The tests in inbox.spec.ts were written and
 * reviewed before this implementation, and are not to be changed to make code
 * pass. Changes here need Henson's line-by-line review.
 */

/**
 * One row per event a consumer has handled. Each service has this table in
 * its own schema:
 *
 *   export const inbox = inboxTable(core);
 *
 * The table is not under the tenant row-level-security policy: it holds no
 * business data, only which event ids have been seen.
 */
export const inboxTable = (schema: PgSchema) =>
  schema.table(
    'inbox',
    {
      /** Names the handler: "core.posting-engine". Two consumers each handle the same event. */
      consumer: text('consumer').notNull(),
      /** The outbox event id. */
      eventId: uuid('event_id').notNull(),
      receivedAt: timestamp('received_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [primaryKey({ columns: [table.consumer, table.eventId] })],
  );

export type InboxTable = ReturnType<typeof inboxTable>;

export interface Delivery {
  consumer: string;
  eventId: string;
}

export type InboxOutcome<Result> =
  | { duplicate: false; result: Result }
  /** The event was handled before. The effect did not run. */
  | { duplicate: true };

export interface InboxOptions {
  table: InboxTable;
}

export interface Inbox {
  /**
   * Runs `effect` unless this consumer has already handled this event.
   *
   * The "seen" record is written in the given transaction, before the effect
   * runs. So the record and the effect commit together: if the effect throws
   * and the transaction rolls back, the record is gone too and a redelivery
   * runs the effect again. If two deliveries of one event arrive at the same
   * moment, the second waits for the first to finish and then sees a
   * duplicate.
   *
   * The transaction is a parameter on purpose: there is no way to use the
   * inbox outside one.
   */
  once<Result>(
    transaction: Transaction,
    delivery: Delivery,
    effect: () => Promise<Result>,
  ): Promise<InboxOutcome<Result>>;
}

export const createInbox = (options: InboxOptions): Inbox => ({
  once: async (transaction, delivery, effect) => {
    // The primary key on (consumer, event_id) does the work. A first delivery
    // inserts. A later one conflicts and inserts nothing. A simultaneous one
    // blocks on the first's uncommitted row until that transaction ends: if
    // it committed this is a conflict, if it rolled back this insert succeeds.
    const inserted = await transaction
      .insert(options.table)
      .values({ consumer: delivery.consumer, eventId: delivery.eventId })
      .onConflictDoNothing()
      .returning({ eventId: options.table.eventId });

    if (inserted.length === 0) {
      return { duplicate: true };
    }
    return { duplicate: false, result: await effect() };
  },
});
