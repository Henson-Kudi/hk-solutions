import {
  createDatabase,
  runWithTenantContext,
  withSystemTransaction,
  withTenantTransaction,
  type Database,
  type TenantContext,
  type Transaction,
} from '@hk/platform/db';
import { createMemoryLogger } from '@hk/platform/logger';
import {
  createOutbox,
  createOutboxRelay,
  outboxTable,
  type OutboxEvent,
} from '@hk/platform/outbox';
import {
  createTestSchema,
  deferred,
  postgresTestUrl,
  type TestSchema,
} from '@hk/platform/testing';
import { createUuidV7Generator } from '@hk/platform/universal';
import { text, uuid, type PgSchema } from 'drizzle-orm/pg-core';
import { createInbox, inboxTable, type Inbox } from './inbox';

/**
 * FAILURE-PATH TESTS FOR A MONEY PATH (plan row 1.4).
 *
 * These were written and reviewed before the implementation, and merged while
 * it did not exist (each was marked it.failing). They are the contract. If a
 * looks wrong, stop and raise it. Do not edit it to make the code pass.
 *
 * They need a real PostgreSQL (see HK_TEST_DATABASE_URL in the README).
 */
const adminUrl = postgresTestUrl();
const describeWithPostgres = adminUrl ? describe : describe.skip;

describe('test setup', () => {
  it('has a PostgreSQL to test against when running in CI', () => {
    if (process.env['CI']) {
      expect(adminUrl).toBeDefined();
    }
  });
});

const define = (schema: PgSchema) => ({
  inbox: inboxTable(schema),
  outbox: outboxTable(schema),
  /** Stands in for what a consumer does with an event, such as posting a journal. */
  journals: schema.table('journals', {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    note: text('note').notNull(),
  }),
});

const nextId = createUuidV7Generator();

const BUSINESS: TenantContext = { tenantId: nextId(), businessId: nextId() };
const POSTING = 'core.posting-engine';
const NOTIFIER = 'core.notifier';

describeWithPostgres('inbox', () => {
  let schema: TestSchema<ReturnType<typeof define>>;
  let database: Database;
  let inbox: Inbox;

  const postJournal = async (
    transaction: Transaction,
    eventId: string,
    note: string,
  ): Promise<void> => {
    await transaction
      .insert(schema.tables.journals)
      .values({ id: nextId(), eventId, note });
  };

  /** Committed journals, read behind the code's back. */
  const journals = async (): Promise<string[]> => {
    const result = await schema.admin.query<{ note: string }>(
      `select note from ${schema.name}.journals order by id`,
    );
    return result.rows.map((row) => row.note);
  };

  const inboxRows = async (): Promise<
    { consumer: string; event_id: string }[]
  > => {
    const result = await schema.admin.query<{
      consumer: string;
      event_id: string;
    }>(`select consumer, event_id from ${schema.name}.inbox order by consumer`);
    return result.rows;
  };

  /** One delivery of an event to the posting consumer, in its own transaction. */
  const deliver = (eventId: string, note: string, consumer = POSTING) =>
    withSystemTransaction(database, (transaction) =>
      inbox.once(transaction, { consumer, eventId }, async () => {
        await postJournal(transaction, eventId, note);
        return note;
      }),
    );

  beforeAll(async () => {
    schema = await createTestSchema({
      adminUrl: adminUrl as string,
      prefix: 'inbox',
      define,
    });
    database = createDatabase({
      url: schema.appUrl,
      name: 'platform-inbox-spec',
      maxConnections: 6,
    });
  }, 60_000);

  afterAll(async () => {
    await database?.close();
    await schema?.drop();
  });

  beforeEach(async () => {
    await schema.truncate('inbox', 'outbox', 'journals');
    inbox = createInbox({ table: schema.tables.inbox });
  });

  describe('duplicate delivery handled once', () => {
    it('runs the effect for a first delivery and returns its result', async () => {
      const eventId = nextId();
      expect(await deliver(eventId, 'journal 1')).toEqual({
        duplicate: false,
        result: 'journal 1',
      });
      expect(await journals()).toEqual(['journal 1']);
      expect(await inboxRows()).toEqual([
        { consumer: POSTING, event_id: eventId },
      ]);
    });

    it('skips the effect for every later delivery of the same event', async () => {
      const eventId = nextId();
      await deliver(eventId, 'first delivery');
      expect(await deliver(eventId, 'second delivery')).toEqual({
        duplicate: true,
      });
      expect(await deliver(eventId, 'third delivery')).toEqual({
        duplicate: true,
      });
      expect(await journals()).toEqual(['first delivery']);
    });

    it('handles different events independently', async () => {
      await deliver(nextId(), 'event A');
      await deliver(nextId(), 'event B');
      expect(await journals()).toEqual(['event A', 'event B']);
    });

    it('lets each consumer handle the same event once', async () => {
      const eventId = nextId();
      await deliver(eventId, 'posted', POSTING);
      await deliver(eventId, 'notified', NOTIFIER);
      expect(await deliver(eventId, 'posted again', POSTING)).toEqual({
        duplicate: true,
      });
      expect(await deliver(eventId, 'notified again', NOTIFIER)).toEqual({
        duplicate: true,
      });
      expect(await journals()).toEqual(['posted', 'notified']);
    });
  });

  describe('an effect that fails', () => {
    it('forgets the delivery, so a redelivery runs the effect again', async () => {
      const eventId = nextId();
      const failure = new Error('ledger period is closed');

      await expect(
        withSystemTransaction(database, (transaction) =>
          inbox.once(transaction, { consumer: POSTING, eventId }, async () => {
            await postJournal(transaction, eventId, 'half done');
            throw failure;
          }),
        ),
      ).rejects.toBe(failure);

      // Neither the effect nor the "seen" record survived.
      expect(await journals()).toEqual([]);
      expect(await inboxRows()).toEqual([]);

      expect(await deliver(eventId, 'redelivered')).toEqual({
        duplicate: false,
        result: 'redelivered',
      });
      expect(await journals()).toEqual(['redelivered']);
    });

    it('forgets the delivery when the transaction fails after the effect', async () => {
      const eventId = nextId();
      await expect(
        withSystemTransaction(database, async (transaction) => {
          await inbox.once(transaction, { consumer: POSTING, eventId }, () =>
            postJournal(transaction, eventId, 'posted'),
          );
          throw new Error('outbox append failed afterwards');
        }),
      ).rejects.toThrow('outbox append failed afterwards');

      expect(await journals()).toEqual([]);
      expect(await deliver(eventId, 'redelivered')).toMatchObject({
        duplicate: false,
      });
    });
  });

  describe('two deliveries of one event at the same moment', () => {
    it('run the effect once: the second waits and then sees a duplicate', async () => {
      const eventId = nextId();
      const firstIsInside = deferred();
      const letFirstFinish = deferred();
      let runs = 0;

      const first = withSystemTransaction(database, (transaction) =>
        inbox.once(transaction, { consumer: POSTING, eventId }, async () => {
          runs += 1;
          await postJournal(transaction, eventId, 'first');
          firstIsInside.resolve();
          await letFirstFinish.promise;
          return 'first';
        }),
      );
      // If the first delivery dies before its effect, fail now instead of waiting.
      await Promise.race([firstIsInside.promise, first]);

      let secondSettled = false;
      const second = withSystemTransaction(database, (transaction) =>
        inbox.once(transaction, { consumer: POSTING, eventId }, async () => {
          runs += 1;
          await postJournal(transaction, eventId, 'second');
          return 'second';
        }),
      ).finally(() => {
        secondSettled = true;
      });

      // The second must not decide anything while the first is undecided.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(secondSettled).toBe(false);

      letFirstFinish.resolve();
      expect(await first).toEqual({ duplicate: false, result: 'first' });
      expect(await second).toEqual({ duplicate: true });
      expect(runs).toBe(1);
      expect(await journals()).toEqual(['first']);
    });

    it('run the effect in the second if the first one fails', async () => {
      const eventId = nextId();
      const firstIsInside = deferred();
      const letFirstFail = deferred();

      const first = withSystemTransaction(database, (transaction) =>
        inbox.once(transaction, { consumer: POSTING, eventId }, async () => {
          await postJournal(transaction, eventId, 'first');
          firstIsInside.resolve();
          await letFirstFail.promise;
          throw new Error('first delivery failed');
        }),
      );
      // If the first delivery dies before its effect, fail now instead of waiting.
      await Promise.race([firstIsInside.promise, first]);

      const second = deliver(eventId, 'second');
      await new Promise((resolve) => setTimeout(resolve, 150));
      letFirstFail.resolve();

      await expect(first).rejects.toThrow('first delivery failed');
      expect(await second).toEqual({ duplicate: false, result: 'second' });
      expect(await journals()).toEqual(['second']);
    });

    it('survive many at once', async () => {
      const eventId = nextId();
      let runs = 0;
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          withSystemTransaction(database, (transaction) =>
            inbox.once(
              transaction,
              { consumer: POSTING, eventId },
              async () => {
                runs += 1;
                await postJournal(transaction, eventId, `delivery ${index}`);
              },
            ),
          ),
        ),
      );
      expect(outcomes.filter((outcome) => !outcome.duplicate)).toHaveLength(1);
      expect(runs).toBe(1);
      expect(await journals()).toHaveLength(1);
    });
  });

  describe('inside a tenant transaction', () => {
    it('works the same, so a consumer can write tenant data in the effect', async () => {
      const eventId = nextId();
      const handle = () =>
        runWithTenantContext(BUSINESS, () =>
          withTenantTransaction(database, (transaction) =>
            inbox.once(transaction, { consumer: POSTING, eventId }, () =>
              postJournal(transaction, eventId, 'posted for the business'),
            ),
          ),
        );
      expect(await handle()).toMatchObject({ duplicate: false });
      expect(await handle()).toEqual({ duplicate: true });
      expect(await journals()).toEqual(['posted for the business']);
    });
  });

  describe('outbox to inbox, end to end', () => {
    it('applies an event once even though the relay delivers it twice', async () => {
      const outbox = createOutbox({ table: schema.tables.outbox });
      const delivered: OutboxEvent[] = [];
      let transportAcceptedOnce = false;

      // The consumer: sets the tenant from the event, then uses the inbox.
      const consume = (event: OutboxEvent) =>
        runWithTenantContext(
          {
            tenantId: event.tenantId as string,
            businessId: event.businessId as string,
          },
          () =>
            withTenantTransaction(database, (transaction) =>
              inbox.once(
                transaction,
                { consumer: POSTING, eventId: event.id },
                () =>
                  postJournal(
                    transaction,
                    event.id,
                    `journal for ${(event.payload as { invoiceId: string }).invoiceId}`,
                  ),
              ),
            ),
        );

      const relay = createOutboxRelay({
        database,
        table: schema.tables.outbox,
        logger: createMemoryLogger().logger,
        retryDelayMs: 0,
        publish: async (event) => {
          delivered.push(event);
          await consume(event);
          if (!transportAcceptedOnce) {
            // Delivered and handled, but the relay never learns it.
            transportAcceptedOnce = true;
            throw new Error('relay died after publishing');
          }
        },
      });

      // The producer: one business change and its event, in one transaction.
      await runWithTenantContext(BUSINESS, () =>
        withTenantTransaction(database, (transaction) =>
          outbox.append(transaction, {
            topic: 'sales.invoice.issued',
            payload: { invoiceId: 'inv-1' },
          }),
        ),
      );

      await relay.drain();
      await relay.drain();

      expect(delivered).toHaveLength(2);
      expect(delivered[0]?.id).toBe(delivered[1]?.id);
      expect(await journals()).toEqual(['journal for inv-1']);
    });
  });
});
