import {
  createDatabase,
  runWithTenantContext,
  withSystemTransaction,
  withTenantTransaction,
  type Database,
  type TenantContext,
} from '@hk/platform/db';
import { createMemoryLogger, type MemoryLogger } from '@hk/platform/logger';
import { createWorker, type JobContext } from '@hk/platform/queue';
import { closeRedis, createRedis, type RedisClient } from '@hk/platform/redis';
import {
  createTestSchema,
  deferred,
  postgresTestUrl,
  redisTestUrl,
  waitFor,
  type TestSchema,
} from '@hk/platform/testing';
import {
  FixedClock,
  Money,
  createUuidV7Generator,
  isUuidV7,
} from '@hk/platform/universal';
import type { PgSchema } from 'drizzle-orm/pg-core';
import {
  createOutbox,
  createOutboxRelay,
  createQueuePublisher,
  outboxTable,
  type Outbox,
  type OutboxEvent,
  type OutboxRelay,
  type Publish,
} from './outbox';

/**
 * FAILURE-PATH TESTS FOR A MONEY PATH (plan row 1.4).
 *
 * These were written and reviewed before the implementation. Each is marked
 * `it.failing`: Jest reports it as passing only while its body fails, and
 * fails the run if it ever passes by accident. When the implementation lands,
 * `it.failing` becomes `it` and nothing else in a test changes. If a test
 * looks wrong, stop and raise it. Do not edit it to make the code pass.
 *
 * They need a real PostgreSQL, and the queue tests a real Redis (see
 * HK_TEST_DATABASE_URL and HK_TEST_REDIS_URL in the README).
 */
const adminUrl = postgresTestUrl();
const redisUrl = redisTestUrl();
const describeWithPostgres = adminUrl ? describe : describe.skip;
const describeWithPostgresAndRedis =
  adminUrl && redisUrl ? describe : describe.skip;

describe('test setup', () => {
  it('has a PostgreSQL and a Redis to test against when running in CI', () => {
    if (process.env['CI']) {
      expect(adminUrl).toBeDefined();
      expect(redisUrl).toBeDefined();
    }
  });
});

const define = (schema: PgSchema) => ({ outbox: outboxTable(schema) });

const nextId = createUuidV7Generator();

const TENANT = nextId();
const BUSINESS_A: TenantContext = { tenantId: TENANT, businessId: nextId() };
const BUSINESS_B: TenantContext = { tenantId: nextId(), businessId: nextId() };

const TOPIC = 'sales.invoice.issued';

describeWithPostgres('outbox', () => {
  let schema: TestSchema<ReturnType<typeof define>>;
  let database: Database;
  let clock: FixedClock;
  let memory: MemoryLogger;
  let outbox: Outbox;

  /** Events handed to the transport, in order. */
  let published: OutboxEvent[];
  const record: Publish = async (event) => {
    published.push(event);
  };

  const relayWith = (
    publish: Publish,
    options: { batchSize?: number } = {},
  ): OutboxRelay =>
    createOutboxRelay({
      database,
      table: schema.tables.outbox,
      publish,
      logger: memory.logger,
      clock,
      retryDelayMs: 1_000,
      maxRetryDelayMs: 8_000,
      ...options,
    });

  /** Appends one event in its own committed system transaction. */
  const emit = (invoiceId: string, topic = TOPIC): Promise<OutboxEvent> =>
    withSystemTransaction(database, (transaction) =>
      outbox.append(transaction, { topic, payload: { invoiceId } }),
    );

  const pendingRows = async (): Promise<
    { id: string; attempts: number; published: boolean }[]
  > => {
    const result = await schema.admin.query<{
      id: string;
      attempts: number;
      published: boolean;
    }>(
      `select id, attempts, published_at is not null as published
         from ${schema.name}.outbox order by id`,
    );
    return result.rows;
  };

  const invoiceIds = (events: OutboxEvent[]): unknown[] =>
    events.map((event) => (event.payload as { invoiceId: string }).invoiceId);

  beforeAll(async () => {
    schema = await createTestSchema({
      adminUrl: adminUrl as string,
      prefix: 'outbox',
      define,
    });
    database = createDatabase({
      url: schema.appUrl,
      name: 'platform-outbox-spec',
      maxConnections: 6,
    });
  }, 60_000);

  afterAll(async () => {
    await database?.close();
    await schema?.drop();
  });

  beforeEach(async () => {
    await schema.truncate('outbox');
    clock = new FixedClock('2026-11-27T10:00:00.000Z');
    memory = createMemoryLogger();
    outbox = createOutbox({ table: schema.tables.outbox, clock });
    published = [];
  });

  describe('append', () => {
    it.failing(
      'returns the event with a UUID v7 id and the time of the clock',
      async () => {
        const event = await emit('inv-1');
        expect(isUuidV7(event.id)).toBe(true);
        expect(event).toEqual({
          id: event.id,
          topic: TOPIC,
          payload: { invoiceId: 'inv-1' },
          tenantId: null,
          businessId: null,
          headers: {},
          occurredAt: '2026-11-27T10:00:00.000Z',
        });
      },
    );

    it.failing('keeps a given id and headers', async () => {
      const id = nextId();
      const event = await withSystemTransaction(database, (transaction) =>
        outbox.append(transaction, {
          id,
          topic: TOPIC,
          payload: {},
          headers: { traceparent: '00-abc-def-01' },
        }),
      );
      expect(event.id).toBe(id);
      expect(event.headers).toEqual({ traceparent: '00-abc-def-01' });
    });

    it.failing(
      'takes tenant and business from the tenant context',
      async () => {
        const event = await runWithTenantContext(BUSINESS_A, () =>
          withTenantTransaction(database, (transaction) =>
            outbox.append(transaction, { topic: TOPIC, payload: {} }),
          ),
        );
        expect(event.tenantId).toBe(BUSINESS_A.tenantId);
        expect(event.businessId).toBe(BUSINESS_A.businessId);
      },
    );

    it.failing(
      'stores money as decimal strings, never as numbers',
      async () => {
        await withSystemTransaction(database, (transaction) =>
          outbox.append(transaction, {
            topic: TOPIC,
            payload: { total: Money.of('1500.50', 'AED') },
          }),
        );
        await relayWith(record).drain();
        expect(published[0]?.payload).toEqual({
          total: { amount: '1500.5', currency: 'AED' },
        });
      },
    );
  });

  describe('an event is published only if its transaction commits', () => {
    it.failing(
      'never publishes an event whose transaction rolled back',
      async () => {
        await expect(
          withSystemTransaction(database, async (transaction) => {
            await outbox.append(transaction, {
              topic: TOPIC,
              payload: { invoiceId: 'never-issued' },
            });
            throw new Error('use case failed after appending');
          }),
        ).rejects.toThrow('use case failed after appending');

        expect(await relayWith(record).drain()).toEqual({
          published: 0,
          failed: 0,
        });
        expect(published).toEqual([]);
        expect(await pendingRows()).toEqual([]);
      },
    );

    it.failing(
      'does not publish an event while its transaction is still open',
      async () => {
        const appended = deferred();
        const commit = deferred();
        const open = withSystemTransaction(database, async (transaction) => {
          await outbox.append(transaction, {
            topic: TOPIC,
            payload: { invoiceId: 'inv-1' },
          });
          appended.resolve();
          await commit.promise;
        });
        // If the transaction dies before appending, fail now instead of waiting.
        await Promise.race([appended.promise, open]);

        expect(await relayWith(record).drain()).toEqual({
          published: 0,
          failed: 0,
        });

        commit.resolve();
        await open;
        expect(await relayWith(record).drain()).toEqual({
          published: 1,
          failed: 0,
        });
        expect(invoiceIds(published)).toEqual(['inv-1']);
      },
    );
  });

  describe('relay', () => {
    it.failing(
      'publishes a committed event once and then leaves it alone',
      async () => {
        const event = await emit('inv-1');
        const relay = relayWith(record);

        expect(await relay.drain()).toEqual({ published: 1, failed: 0 });
        expect(await relay.drain()).toEqual({ published: 0, failed: 0 });
        expect(published).toEqual([event]);
        expect(await pendingRows()).toEqual([
          { id: event.id, attempts: 1, published: true },
        ]);
      },
    );

    it.failing('publishes in the order the events were written', async () => {
      for (const invoiceId of ['inv-1', 'inv-2', 'inv-3', 'inv-4', 'inv-5']) {
        await emit(invoiceId);
      }
      await relayWith(record, { batchSize: 2 }).drain();
      await relayWith(record, { batchSize: 2 }).drain();
      await relayWith(record, { batchSize: 2 }).drain();
      expect(invoiceIds(published)).toEqual([
        'inv-1',
        'inv-2',
        'inv-3',
        'inv-4',
        'inv-5',
      ]);
    });

    it.failing('publishes the events of every business', async () => {
      for (const context of [BUSINESS_A, BUSINESS_B]) {
        await runWithTenantContext(context, () =>
          withTenantTransaction(database, (transaction) =>
            outbox.append(transaction, { topic: TOPIC, payload: {} }),
          ),
        );
      }
      await relayWith(record).drain();
      expect(published.map((event) => event.businessId)).toEqual([
        BUSINESS_A.businessId,
        BUSINESS_B.businessId,
      ]);
    });
  });

  describe('a publish that fails', () => {
    it.failing(
      'keeps the event, counts the attempt and tries again later',
      async () => {
        const event = await emit('inv-1');
        let healthy = false;
        const flaky: Publish = async (candidate) => {
          if (!healthy) {
            throw new Error('redis unreachable');
          }
          published.push(candidate);
        };
        const relay = relayWith(flaky);

        expect(await relay.drain()).toEqual({ published: 0, failed: 1 });
        expect(await pendingRows()).toEqual([
          { id: event.id, attempts: 1, published: false },
        ]);

        // Not due yet: the relay backs off instead of hammering a broken transport.
        healthy = true;
        clock.advance(999);
        expect(await relay.drain()).toEqual({ published: 0, failed: 0 });

        clock.advance(1);
        expect(await relay.drain()).toEqual({ published: 1, failed: 0 });
        expect(published).toEqual([event]);
        expect(await pendingRows()).toEqual([
          { id: event.id, attempts: 2, published: true },
        ]);
      },
    );

    it.failing(
      'backs off further after each failure, up to the maximum',
      async () => {
        await emit('inv-1');
        const relay = relayWith(async () => {
          throw new Error('still down');
        });

        // Delays double: 1s, 2s, 4s, 8s, then stay at the 8s maximum.
        for (const delay of [1_000, 2_000, 4_000, 8_000, 8_000]) {
          expect(await relay.drain()).toEqual({ published: 0, failed: 1 });
          clock.advance(delay - 1);
          expect(await relay.drain()).toEqual({ published: 0, failed: 0 });
          clock.advance(1);
        }
        expect((await pendingRows())[0]?.attempts).toBe(5);
      },
    );

    it.failing('does not let one bad event hold back the others', async () => {
      await emit('inv-1');
      await emit('poison');
      await emit('inv-3');
      const relay = relayWith(async (event) => {
        if ((event.payload as { invoiceId: string }).invoiceId === 'poison') {
          throw new Error('cannot publish this one');
        }
        published.push(event);
      });

      expect(await relay.drain()).toEqual({ published: 2, failed: 1 });
      expect(invoiceIds(published)).toEqual(['inv-1', 'inv-3']);
      expect((await pendingRows()).map((row) => row.published)).toEqual([
        true,
        false,
        true,
      ]);
    });

    it.failing(
      'logs the failure with the event id and topic, and never the payload',
      async () => {
        await withSystemTransaction(database, (transaction) =>
          outbox.append(transaction, {
            topic: TOPIC,
            payload: { customerPhone: '677123456' },
          }),
        );
        await relayWith(async () => {
          throw new Error('down');
        }).drain();

        expect(memory.entries).toContainEqual(
          expect.objectContaining({ level: 'warn', topic: TOPIC }),
        );
        expect(memory.text()).not.toContain('677123456');
      },
    );
  });

  describe('a crash between publishing and marking', () => {
    it.failing('publishes the event again, with the same id', async () => {
      const event = await emit('inv-1');
      let first = true;
      // The transport accepted the event, then the relay died before it could
      // record that. To the relay this is indistinguishable from a failure.
      const acceptThenDie: Publish = async (candidate) => {
        published.push(candidate);
        if (first) {
          first = false;
          throw new Error('process died after publish');
        }
      };
      const relay = relayWith(acceptThenDie);

      await relay.drain();
      clock.advance(1_000);
      await relay.drain();

      // At least once: the consumer sees it twice and must deduplicate on the id.
      expect(published).toEqual([event, event]);
      expect(await pendingRows()).toEqual([
        { id: event.id, attempts: 2, published: true },
      ]);
    });
  });

  describe('several relays at once', () => {
    it.failing('publish each event exactly once between them', async () => {
      const total = 40;
      for (let index = 0; index < total; index += 1) {
        await emit(`inv-${index}`);
      }
      const slow: Publish = async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        published.push(event);
      };
      const relays = [
        relayWith(slow, { batchSize: 7 }),
        relayWith(slow, { batchSize: 7 }),
        relayWith(slow, { batchSize: 7 }),
      ];

      let remaining = total;
      while (remaining > 0) {
        const passes = await Promise.all(relays.map((relay) => relay.drain()));
        const count = passes.reduce((sum, pass) => sum + pass.published, 0);
        expect(count).toBeGreaterThan(0);
        remaining -= count;
      }

      expect(published).toHaveLength(total);
      expect(new Set(published.map((event) => event.id)).size).toBe(total);
      expect(
        (await pendingRows()).every(
          (row) => row.published && row.attempts === 1,
        ),
      ).toBe(true);
    });
  });

  describe('start and stop', () => {
    it.failing(
      'keeps draining until stopped, and stop waits for the pass in progress',
      async () => {
        const relay = relayWith(record);
        relay.start(20);
        await emit('inv-1');
        await waitFor(() => published.length === 1);
        await emit('inv-2');
        await waitFor(() => published.length === 2);

        await relay.stop();
        await emit('inv-3');
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(invoiceIds(published)).toEqual(['inv-1', 'inv-2']);
      },
    );
  });
});

describeWithPostgresAndRedis('outbox to BullMQ', () => {
  let schema: TestSchema<ReturnType<typeof define>>;
  let database: Database;
  let connection: RedisClient;
  let memory: MemoryLogger;

  beforeAll(async () => {
    schema = await createTestSchema({
      adminUrl: adminUrl as string,
      prefix: 'outboxq',
      define,
    });
    database = createDatabase({
      url: schema.appUrl,
      name: 'platform-outbox-queue-spec',
    });
    connection = createRedis({
      url: redisUrl as string,
      name: 'platform-outbox-spec',
      purpose: 'queue',
    });
  }, 60_000);

  afterAll(async () => {
    await closeRedis(connection);
    await database?.close();
    await schema?.drop();
  });

  beforeEach(() => {
    memory = createMemoryLogger();
  });

  it.failing(
    'delivers a committed event to a worker on the queue named after its topic',
    async () => {
      const topic = `spec.outbox.t${Date.now()}`;
      const received: JobContext<OutboxEvent>[] = [];
      const worker = createWorker<OutboxEvent>({
        name: topic,
        connection,
        logger: memory.logger,
        handler: async (job) => {
          received.push(job);
        },
      });
      await worker.ready();
      const publisher = createQueuePublisher({ connection });
      const outbox = createOutbox({ table: schema.tables.outbox });

      try {
        const event = await runWithTenantContext(BUSINESS_A, () =>
          withTenantTransaction(database, (transaction) =>
            outbox.append(transaction, {
              topic,
              payload: { invoiceId: 'inv-1' },
              headers: { traceparent: '00-abc-def-01' },
            }),
          ),
        );
        const relay = createOutboxRelay({
          database,
          table: schema.tables.outbox,
          publish: publisher.publish,
          logger: memory.logger,
        });
        expect(await relay.drain()).toEqual({ published: 1, failed: 0 });

        await waitFor(() => received.length === 1);
        expect(received[0]).toMatchObject({
          id: event.id,
          name: topic,
          data: event,
        });
        expect(received[0]?.data.businessId).toBe(BUSINESS_A.businessId);
      } finally {
        await worker.close();
        await publisher.close();
      }
    },
  );

  it.failing(
    'enqueues one job when the same event is published twice',
    async () => {
      const topic = `spec.outbox.d${Date.now()}`;
      const publisher = createQueuePublisher({ connection });
      const event: OutboxEvent = {
        id: nextId(),
        topic,
        payload: { invoiceId: 'inv-1' },
        tenantId: null,
        businessId: null,
        headers: {},
        occurredAt: '2026-11-27T10:00:00.000Z',
      };
      const received: string[] = [];

      try {
        await publisher.publish(event);
        await publisher.publish(event);

        const worker = createWorker<OutboxEvent>({
          name: topic,
          connection,
          logger: memory.logger,
          handler: async (job) => {
            received.push(job.id);
          },
        });
        await worker.ready();
        await waitFor(() => received.length >= 1);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await worker.close();

        expect(received).toEqual([event.id]);
      } finally {
        await publisher.close();
      }
    },
  );
});
