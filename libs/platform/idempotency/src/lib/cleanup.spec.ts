import { createDatabase, type Database } from '@hk/platform/db';
import {
  createTestSchema,
  deferred,
  postgresTestUrl,
  type TestSchema,
} from '@hk/platform/testing';
import { FixedClock } from '@hk/platform/universal';
import type { PgSchema } from 'drizzle-orm/pg-core';
import { createIdempotencyCleanup } from './cleanup';
import {
  IDEMPOTENCY_ERRORS,
  createIdempotency,
  idempotencyKeysTable,
  type Idempotency,
} from './idempotency';

/**
 * FAILURE-PATH TESTS FOR A MONEY PATH (plan row 1.4).
 *
 * These were written and reviewed before the implementation. Each is marked
 * `it.failing`: Jest reports it as passing only while its body fails, and
 * fails the run if it ever passes by accident. When the implementation lands,
 * `it.failing` becomes `it` and nothing else in a test changes. If a test
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

const define = (schema: PgSchema) => ({ keys: idempotencyKeysTable(schema) });

const RETENTION_MS = 60 * 60 * 1_000;
const LEASE_MS = 30_000;

describeWithPostgres('idempotency cleanup', () => {
  let schema: TestSchema<ReturnType<typeof define>>;
  let database: Database;
  let clock: FixedClock;
  let idempotency: Idempotency;

  const cleanup = (batchSize?: number) =>
    createIdempotencyCleanup({
      database,
      table: schema.tables.keys,
      clock,
      ...(batchSize === undefined ? {} : { batchSize }),
    });

  /** Completes one request under `key`, at the clock's current time. */
  const use = (key: string) =>
    idempotency.execute(
      { key, operation: 'POST /payments', request: { amount: '100.00' } },
      async () => ({ status: 201, body: { key } }),
    );

  const storedKeys = async (): Promise<string[]> => {
    const result = await schema.admin.query<{ key: string }>(
      `select key from ${schema.name}.idempotency_keys order by key`,
    );
    return result.rows.map((row) => row.key);
  };

  beforeAll(async () => {
    schema = await createTestSchema({
      adminUrl: adminUrl as string,
      prefix: 'idemclean',
      define,
    });
    database = createDatabase({
      url: schema.appUrl,
      name: 'platform-idempotency-cleanup-spec',
    });
  }, 60_000);

  afterAll(async () => {
    await database?.close();
    await schema?.drop();
  });

  beforeEach(async () => {
    await schema.truncate('idempotency_keys');
    clock = new FixedClock('2026-11-27T10:00:00.000Z');
    idempotency = createIdempotency({
      database,
      table: schema.tables.keys,
      clock,
      leaseMs: LEASE_MS,
      retentionMs: RETENTION_MS,
    });
  });

  it.failing(
    'deletes nothing while every key is within its retention',
    async () => {
      await use('key-1');
      clock.advance(RETENTION_MS - 1);
      expect(await cleanup().purge()).toBe(0);
      expect(await storedKeys()).toEqual(['key-1']);
    },
  );

  it.failing(
    'deletes keys once their retention has passed, and only those',
    async () => {
      await use('old-1');
      await use('old-2');
      clock.advance(RETENTION_MS / 2);
      await use('recent');
      clock.advance(RETENTION_MS / 2);

      expect(await cleanup().purge()).toBe(2);
      expect(await storedKeys()).toEqual(['recent']);
    },
  );

  it.failing('keeps replaying a key right up to its expiry', async () => {
    await use('key-1');
    clock.advance(RETENTION_MS - 1);
    await cleanup().purge();

    let runs = 0;
    const replay = await idempotency.execute(
      {
        key: 'key-1',
        operation: 'POST /payments',
        request: { amount: '100.00' },
      },
      async () => {
        runs += 1;
        return { status: 201, body: { second: true } };
      },
    );
    expect(replay).toEqual({
      response: { status: 201, body: { key: 'key-1' } },
      replayed: true,
    });
    expect(runs).toBe(0);
  });

  it.failing(
    'treats a purged key as never used: it runs again, with any request',
    async () => {
      await use('key-1');
      clock.advance(RETENTION_MS);
      expect(await cleanup().purge()).toBe(1);

      const again = await idempotency.execute(
        {
          key: 'key-1',
          operation: 'POST /refunds',
          request: { amount: '5.00' },
        },
        async () => ({ status: 201, body: { fresh: true } }),
      );
      expect(again).toEqual({
        response: { status: 201, body: { fresh: true } },
        replayed: false,
      });
    },
  );

  it.failing('deletes at most one batch per call, oldest first', async () => {
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      await use(key);
      clock.advance(1_000);
    }
    clock.advance(RETENTION_MS);

    const job = cleanup(2);
    expect(await job.purge()).toBe(2);
    expect(await storedKeys()).toEqual(['c', 'd', 'e']);
    expect(await job.purge()).toBe(2);
    expect(await job.purge()).toBe(1);
    expect(await job.purge()).toBe(0);
    expect(await storedKeys()).toEqual([]);
  });

  it.failing(
    'never deletes a key that is still in flight with a live lease',
    async () => {
      // A short retention makes the key "expired" while its request is still running.
      const shortRetention = createIdempotency({
        database,
        table: schema.tables.keys,
        clock,
        leaseMs: LEASE_MS,
        retentionMs: 1_000,
      });
      const inside = deferred();
      const gate = deferred();
      const call = { key: 'key-1', operation: 'POST /payments', request: {} };
      const first = shortRetention.execute(call, async () => {
        inside.resolve();
        await gate.promise;
        return { status: 201, body: { attempt: 'first' } };
      });
      // If the first request dies before its handler, fail now instead of waiting.
      await Promise.race([inside.promise, first]);

      try {
        clock.advance(5_000);
        expect(await cleanup().purge()).toBe(0);

        // The key must still be protecting the first request.
        await expect(
          shortRetention.execute(call, async () => ({ status: 201, body: {} })),
        ).rejects.toMatchObject({ code: IDEMPOTENCY_ERRORS.IN_FLIGHT });
      } finally {
        // Whatever happened above, let the first request finish, so a
        // failure here cannot leave a transaction open behind it.
        gate.resolve();
      }
      expect((await first).response.body).toEqual({ attempt: 'first' });
    },
  );

  it.failing(
    'deletes an abandoned key: in flight, lease expired, retention passed',
    async () => {
      // Left behind by a process that died mid-request.
      await schema.admin.query(
        `insert into ${schema.name}.idempotency_keys
         (id, scope, key, operation, request_hash, status, lease_token,
          lease_expires_at, created_at, expires_at)
       values (gen_random_uuid(), 'public', 'abandoned', 'POST /payments', 'hash',
               'IN_PROGRESS', gen_random_uuid(),
               '2026-11-27T10:00:30.000Z', '2026-11-27T10:00:00.000Z',
               '2026-11-27T11:00:00.000Z')`,
      );
      clock.advance(RETENTION_MS);
      expect(await cleanup().purge()).toBe(1);
      expect(await storedKeys()).toEqual([]);
    },
  );
});
