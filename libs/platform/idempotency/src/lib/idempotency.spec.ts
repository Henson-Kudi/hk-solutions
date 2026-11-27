import {
  createDatabase,
  isInTransaction,
  requireSystemTransaction,
  requireTenantTransaction,
  runWithTenantContext,
  type Database,
  type TenantContext,
  type Transaction,
} from '@hk/platform/db';
import { AppError } from '@hk/platform/errors';
import {
  createTestSchema,
  deferred,
  postgresTestUrl,
  type TestSchema,
} from '@hk/platform/testing';
import { FixedClock, createUuidV7Generator } from '@hk/platform/universal';
import { text, uuid, type PgSchema } from 'drizzle-orm/pg-core';
import {
  IDEMPOTENCY_ERRORS,
  createIdempotency,
  idempotencyKeysTable,
  type Idempotency,
  type IdempotentCall,
  type IdempotentResponse,
} from './idempotency';

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
  keys: idempotencyKeysTable(schema),
  /** Stands in for the business change a handler makes, such as a payment. */
  effects: schema.table('effects', {
    id: uuid('id').primaryKey(),
    note: text('note').notNull(),
  }),
});

const nextId = createUuidV7Generator();

const TENANT = nextId();
const BUSINESS_A: TenantContext = { tenantId: TENANT, businessId: nextId() };
const BUSINESS_B: TenantContext = { tenantId: TENANT, businessId: nextId() };

const LEASE_MS = 30_000;

/** The AppError a call fails with, or a description of what happened instead. */
const failureOf = async (
  action: Promise<unknown>,
): Promise<{ code: string; status: number }> => {
  try {
    await action;
  } catch (error) {
    if (error instanceof AppError) {
      return { code: error.code, status: error.status };
    }
    return { code: `NOT_AN_APP_ERROR: ${String(error)}`, status: 0 };
  }
  return { code: 'DID_NOT_THROW', status: 0 };
};

describeWithPostgres('idempotency', () => {
  let schema: TestSchema<ReturnType<typeof define>>;
  let database: Database;
  let clock: FixedClock;
  let idempotency: Idempotency;

  const call = (
    key: string | undefined,
    request: unknown = { amount: '100.00', currency: 'XAF' },
    operation = 'POST /payments',
  ): IdempotentCall => ({ key, operation, request });

  const writeEffect = async (
    transaction: Transaction,
    note: string,
  ): Promise<void> => {
    await transaction
      .insert(schema.tables.effects)
      .values({ id: nextId(), note });
  };

  /** What is committed in the effects table, read behind the code's back. */
  const effects = async (): Promise<string[]> => {
    const result = await schema.admin.query<{ note: string }>(
      `select note from ${schema.name}.effects order by id`,
    );
    return result.rows.map((row) => row.note);
  };

  /** A handler that records how often it ran, makes one business change and answers 201. */
  const payment = (note = 'payment') => {
    const state = { runs: 0 };
    const handler = async (
      transaction: Transaction,
    ): Promise<IdempotentResponse> => {
      state.runs += 1;
      await writeEffect(transaction, note);
      return { status: 201, body: { paymentId: `pay-${state.runs}`, note } };
    };
    return { state, handler };
  };

  beforeAll(async () => {
    schema = await createTestSchema({
      adminUrl: adminUrl as string,
      prefix: 'idem',
      define,
    });
    database = createDatabase({
      url: schema.appUrl,
      name: 'platform-idempotency-spec',
      maxConnections: 5,
    });
  }, 60_000);

  afterAll(async () => {
    await database?.close();
    await schema?.drop();
  });

  beforeEach(async () => {
    await schema.truncate('idempotency_keys', 'effects');
    clock = new FixedClock('2026-11-27T10:00:00.000Z');
    idempotency = createIdempotency({
      database,
      table: schema.tables.keys,
      clock,
      leaseMs: LEASE_MS,
    });
  });

  describe('missing or malformed key', () => {
    it('answers 400 without a key, and does not run the handler', async () => {
      const { state, handler } = payment();
      expect(
        await failureOf(idempotency.execute(call(undefined), handler)),
      ).toEqual({
        code: IDEMPOTENCY_ERRORS.KEY_MISSING,
        status: 400,
      });
      expect(state.runs).toBe(0);
      expect(await effects()).toEqual([]);
    });

    it.each([
      ['empty', ''],
      ['only spaces', '   '],
      ['longer than 255 characters', 'k'.repeat(256)],
      ['with a line break', 'key\nwith-break'],
      ['with a non-ASCII character', 'clé-1'],
    ])('answers 400 for a key that is %s', async (_label, key) => {
      const { state, handler } = payment();
      expect(await failureOf(idempotency.execute(call(key), handler))).toEqual({
        code: IDEMPOTENCY_ERRORS.KEY_INVALID,
        status: 400,
      });
      expect(state.runs).toBe(0);
    });
  });

  describe('first use and replay', () => {
    it('runs the handler once and returns its response', async () => {
      const { state, handler } = payment();
      const result = await idempotency.execute(call('key-1'), handler);
      expect(result).toEqual({
        response: {
          status: 201,
          body: { paymentId: 'pay-1', note: 'payment' },
        },
        replayed: false,
      });
      expect(state.runs).toBe(1);
      expect(await effects()).toEqual(['payment']);
    });

    it('replays the stored response and does not run the handler again', async () => {
      const { state, handler } = payment();
      const first = await idempotency.execute(call('key-1'), handler);
      const second = await idempotency.execute(call('key-1'), handler);
      const third = await idempotency.execute(call('key-1'), handler);

      expect(second).toEqual({ response: first.response, replayed: true });
      expect(third).toEqual({ response: first.response, replayed: true });
      expect(state.runs).toBe(1);
      expect(await effects()).toEqual(['payment']);
    });

    it('replays what was stored, not what the handler would say now', async () => {
      await idempotency.execute(call('key-1'), async () => ({
        status: 201,
        body: { balance: '900.00' },
      }));
      const replay = await idempotency.execute(call('key-1'), async () => ({
        status: 200,
        body: { balance: '0.00' },
      }));
      expect(replay).toEqual({
        response: { status: 201, body: { balance: '900.00' } },
        replayed: true,
      });
    });

    it('treats the same request with its keys in another order as the same', async () => {
      const { state, handler } = payment();
      await idempotency.execute(
        call('key-1', {
          amount: '100.00',
          currency: 'XAF',
          lines: [{ a: 1, b: 2 }],
        }),
        handler,
      );
      const replay = await idempotency.execute(
        call('key-1', {
          lines: [{ b: 2, a: 1 }],
          currency: 'XAF',
          amount: '100.00',
        }),
        handler,
      );
      expect(replay.replayed).toBe(true);
      expect(state.runs).toBe(1);
    });

    it('still replays after the lease time has long passed', async () => {
      const { state, handler } = payment();
      const first = await idempotency.execute(call('key-1'), handler);
      clock.advance(LEASE_MS * 10);
      const replay = await idempotency.execute(call('key-1'), handler);
      expect(replay).toEqual({ response: first.response, replayed: true });
      expect(state.runs).toBe(1);
    });

    it('stores only a hash of the request, never the request', async () => {
      await idempotency.execute(
        call('key-1', { otp: '424242', phone: '677123456' }),
        async () => ({ status: 204, body: null }),
      );
      const rows = await schema.admin.query(
        `select * from ${schema.name}.idempotency_keys`,
      );
      expect(rows.rows).toHaveLength(1);
      const stored = JSON.stringify(rows.rows);
      expect(stored).not.toContain('424242');
      expect(stored).not.toContain('677123456');
    });
  });

  describe('a request still in flight', () => {
    it('answers 409 to a second request with the same key', async () => {
      const gate = deferred();
      let runs = 0;
      const first = idempotency.execute(call('key-1'), async (transaction) => {
        runs += 1;
        await writeEffect(transaction, 'first');
        await gate.promise;
        return { status: 201, body: { attempt: 'first' } };
      });
      // Let the first request claim the key before the second arrives.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const second = payment('second');
      expect(
        await failureOf(idempotency.execute(call('key-1'), second.handler)),
      ).toEqual({ code: IDEMPOTENCY_ERRORS.IN_FLIGHT, status: 409 });
      expect(second.state.runs).toBe(0);

      gate.resolve();
      expect((await first).response.body).toEqual({ attempt: 'first' });

      const replay = await idempotency.execute(call('key-1'), second.handler);
      expect(replay).toEqual({
        response: { status: 201, body: { attempt: 'first' } },
        replayed: true,
      });
      expect(runs).toBe(1);
      expect(await effects()).toEqual(['first']);
    });

    it('lets exactly one of two simultaneous first requests run', async () => {
      let runs = 0;
      const handler = async (transaction: Transaction) => {
        runs += 1;
        await writeEffect(transaction, 'payment');
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { status: 201, body: { ok: true } };
      };
      const outcomes = await Promise.allSettled([
        idempotency.execute(call('key-1'), handler),
        idempotency.execute(call('key-1'), handler),
        idempotency.execute(call('key-1'), handler),
      ]);

      const succeeded = outcomes.filter(
        (outcome) => outcome.status === 'fulfilled',
      );
      const rejected = outcomes.filter(
        (outcome) => outcome.status === 'rejected',
      );
      expect(succeeded).toHaveLength(1);
      for (const outcome of rejected) {
        expect((outcome as PromiseRejectedResult).reason).toMatchObject({
          code: IDEMPOTENCY_ERRORS.IN_FLIGHT,
          status: 409,
        });
      }
      expect(runs).toBe(1);
      expect(await effects()).toEqual(['payment']);
    });

    it('lets a new attempt take over once the lease has expired, and stops the old one from committing', async () => {
      const gate = deferred();
      const slow = idempotency.execute(call('key-1'), async (transaction) => {
        await writeEffect(transaction, 'slow attempt');
        await gate.promise;
        return { status: 201, body: { attempt: 'slow' } };
      });
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Within the lease the key is still taken.
      clock.advance(LEASE_MS - 1);
      const early = payment('early');
      expect(
        await failureOf(idempotency.execute(call('key-1'), early.handler)),
      ).toMatchObject({ code: IDEMPOTENCY_ERRORS.IN_FLIGHT });

      // After it, a retry may run: the first attempt is presumed dead.
      clock.advance(2);
      const takeover = await idempotency.execute(
        call('key-1'),
        async (transaction) => {
          await writeEffect(transaction, 'takeover');
          return { status: 201, body: { attempt: 'takeover' } };
        },
      );
      expect(takeover).toEqual({
        response: { status: 201, body: { attempt: 'takeover' } },
        replayed: false,
      });

      // The slow attempt was not dead after all. It must not commit.
      gate.resolve();
      expect(await failureOf(slow)).toEqual({
        code: IDEMPOTENCY_ERRORS.LEASE_LOST,
        status: 409,
      });
      expect(await effects()).toEqual(['takeover']);

      const replay = await idempotency.execute(call('key-1'), early.handler);
      expect(replay.response.body).toEqual({ attempt: 'takeover' });
      expect(early.state.runs).toBe(0);
    });
  });

  describe('a key reused for something else', () => {
    it('answers 422 when the body differs, and keeps the first result', async () => {
      const { handler } = payment();
      const first = await idempotency.execute(
        call('key-1', { amount: '100.00', currency: 'XAF' }),
        handler,
      );

      const other = payment('other');
      expect(
        await failureOf(
          idempotency.execute(
            call('key-1', { amount: '999.00', currency: 'XAF' }),
            other.handler,
          ),
        ),
      ).toEqual({ code: IDEMPOTENCY_ERRORS.KEY_REUSED, status: 422 });
      expect(other.state.runs).toBe(0);
      expect(await effects()).toEqual(['payment']);

      const replay = await idempotency.execute(
        call('key-1', { amount: '100.00', currency: 'XAF' }),
        other.handler,
      );
      expect(replay).toEqual({ response: first.response, replayed: true });
    });

    it('answers 422 when the operation differs', async () => {
      await idempotency.execute(call('key-1'), payment().handler);
      const refund = payment('refund');
      expect(
        await failureOf(
          idempotency.execute(
            call(
              'key-1',
              { amount: '100.00', currency: 'XAF' },
              'POST /refunds',
            ),
            refund.handler,
          ),
        ),
      ).toEqual({ code: IDEMPOTENCY_ERRORS.KEY_REUSED, status: 422 });
      expect(refund.state.runs).toBe(0);
    });

    it('answers 422, not 409, when a different body arrives while the first is in flight', async () => {
      const gate = deferred();
      const first = idempotency.execute(call('key-1'), async () => {
        await gate.promise;
        return { status: 201, body: {} };
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(
        await failureOf(
          idempotency.execute(
            call('key-1', { amount: '5.00' }),
            payment().handler,
          ),
        ),
      ).toEqual({ code: IDEMPOTENCY_ERRORS.KEY_REUSED, status: 422 });
      gate.resolve();
      await first;
    });
  });

  describe('rollback re-executes', () => {
    it('stores nothing when the handler throws, so the same key can retry', async () => {
      const failure = new Error('provider unreachable');
      let runs = 0;
      const flaky = async (transaction: Transaction) => {
        runs += 1;
        await writeEffect(transaction, `attempt ${runs}`);
        if (runs === 1) {
          throw failure;
        }
        return { status: 201, body: { attempt: runs } };
      };

      // The caller sees the original error, not an idempotency error.
      await expect(idempotency.execute(call('key-1'), flaky)).rejects.toBe(
        failure,
      );
      // The business change of the failed attempt is gone with it.
      expect(await effects()).toEqual([]);

      // The retry is a real execution, not a replay of the failure and not a 409.
      const retry = await idempotency.execute(call('key-1'), flaky);
      expect(retry).toEqual({
        response: { status: 201, body: { attempt: 2 } },
        replayed: false,
      });
      expect(await effects()).toEqual(['attempt 2']);

      const replay = await idempotency.execute(call('key-1'), flaky);
      expect(replay).toEqual({ response: retry.response, replayed: true });
      expect(runs).toBe(2);
    });

    it('can retry with a corrected body after a failed attempt', async () => {
      await expect(
        idempotency.execute(call('key-1', { amount: '-1' }), async () => {
          throw new Error('amount must be positive');
        }),
      ).rejects.toThrow('amount must be positive');

      const { state, handler } = payment();
      const retry = await idempotency.execute(
        call('key-1', { amount: '100.00' }),
        handler,
      );
      expect(retry.replayed).toBe(false);
      expect(state.runs).toBe(1);
    });
  });

  describe('crash after commit rebuilds', () => {
    /**
     * A database whose transactions commit for real and then report failure,
     * as when the process dies, or the connection drops, between COMMIT and
     * the response reaching the caller.
     */
    const dyingAfterCommit = (real: Database): Database => ({
      ...real,
      drizzle: new Proxy(real.drizzle, {
        get(target, property, receiver) {
          if (property === 'transaction') {
            return async (...args: Parameters<typeof target.transaction>) => {
              await target.transaction(...args);
              throw new Error('process died after commit');
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });

    it('returns the committed result to the retry instead of running again', async () => {
      const dying = createIdempotency({
        database: dyingAfterCommit(database),
        table: schema.tables.keys,
        clock,
        leaseMs: LEASE_MS,
      });
      const { state, handler } = payment();

      // The first caller never gets an answer, but the payment is committed.
      await expect(dying.execute(call('key-1'), handler)).rejects.toThrow(
        'process died after commit',
      );
      expect(await effects()).toEqual(['payment']);

      // The retry, on a healthy process, must not pay a second time. It gets
      // the answer the first caller should have had, at once and without
      // waiting for a lease to expire.
      const retry = await idempotency.execute(call('key-1'), handler);
      expect(retry).toEqual({
        response: {
          status: 201,
          body: { paymentId: 'pay-1', note: 'payment' },
        },
        replayed: true,
      });
      expect(state.runs).toBe(1);
      expect(await effects()).toEqual(['payment']);
    });
  });

  describe('scope', () => {
    it('keeps the same key apart for two businesses', async () => {
      const a = payment('for A');
      const b = payment('for B');
      const resultA = await runWithTenantContext(BUSINESS_A, () =>
        idempotency.execute(call('key-1'), a.handler),
      );
      const resultB = await runWithTenantContext(BUSINESS_B, () =>
        idempotency.execute(call('key-1'), b.handler),
      );
      expect(resultA.replayed).toBe(false);
      expect(resultB.replayed).toBe(false);
      expect(await effects()).toEqual(['for A', 'for B']);

      const replayA = await runWithTenantContext(BUSINESS_A, () =>
        idempotency.execute(call('key-1'), b.handler),
      );
      expect(replayA.response.body).toMatchObject({ note: 'for A' });
    });

    it('keeps a signed-in key apart from the same key sent before sign-in', async () => {
      const publicCall = payment('public');
      const tenantCall = payment('tenant');
      await idempotency.execute(call('key-1'), publicCall.handler);
      const result = await runWithTenantContext(BUSINESS_A, () =>
        idempotency.execute(call('key-1'), tenantCall.handler),
      );
      expect(result.replayed).toBe(false);
      expect(tenantCall.state.runs).toBe(1);
    });

    it('runs the handler in a tenant transaction when a tenant context is active', async () => {
      let inside: { open: boolean; sameTransaction: boolean } | undefined;
      await runWithTenantContext(BUSINESS_A, () =>
        idempotency.execute(call('key-1'), async (transaction) => {
          inside = {
            open: isInTransaction(),
            sameTransaction: requireTenantTransaction() === transaction,
          };
          return { status: 204, body: null };
        }),
      );
      expect(inside).toEqual({ open: true, sameTransaction: true });
    });

    it('runs the handler in a system transaction when there is no tenant context', async () => {
      let sameTransaction = false;
      await idempotency.execute(call('key-1'), async (transaction) => {
        sameTransaction = requireSystemTransaction() === transaction;
        return { status: 204, body: null };
      });
      expect(sameTransaction).toBe(true);
    });
  });
});
