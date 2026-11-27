import {
  createDatabase,
  requireSystemTransaction,
  type Database,
} from '@hk/platform/db';
import {
  createIdempotency,
  idempotencyKeysTable,
} from '@hk/platform/idempotency';
import { createMemoryLogger, type MemoryLogger } from '@hk/platform/logger';
import {
  createTestSchema,
  deferred,
  postgresTestUrl,
  type Deferred,
  type TestSchema,
} from '@hk/platform/testing';
import { DomainError, createUuidV7Generator } from '@hk/platform/universal';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  type INestApplication,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { text, uuid, type PgSchema } from 'drizzle-orm/pg-core';
import request from 'supertest';
import {
  IdempotencyExempt,
  IdempotencyInterceptor,
  Idempotent,
  findUncoveredRoutes,
} from './idempotent';
import { LoggerModule } from './logger.module';
import { setupHttpApp } from './setup-http-app';
import { IDEMPOTENCY } from './tokens';

/**
 * FAILURE-PATH TESTS FOR A MONEY PATH (plan row 1.4).
 *
 * These were written and reviewed before the implementation. Each is marked
 * `it.failing`: Jest reports it as passing only while its body fails, and
 * fails the run if it ever passes by accident. When the implementation lands,
 * `it.failing` becomes `it` and nothing else in a test changes. If a test
 * looks wrong, stop and raise it. Do not edit it to make the code pass.
 *
 * The HTTP tests need a real PostgreSQL (see HK_TEST_DATABASE_URL).
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
  /** Stands in for the business change a handler makes. */
  payments: schema.table('payments', {
    id: uuid('id').primaryKey(),
    note: text('note').notNull(),
  }),
});

const nextId = createUuidV7Generator();

/** Shared with the controller, which Nest constructs. Reset before each test. */
const state: {
  schema?: TestSchema<ReturnType<typeof define>>;
  runs: number;
  /** When set, the next create() call announces itself and waits here. */
  hold?: { inside: Deferred<void>; gate: Deferred<void> };
  failNext: boolean;
} = { runs: 0, failNext: false };

const pay = async (note: string): Promise<void> => {
  const schema = state.schema as TestSchema<ReturnType<typeof define>>;
  await requireSystemTransaction()
    .insert(schema.tables.payments)
    .values({ id: nextId(), note });
};

@Controller('payments')
class PaymentsController {
  @Post()
  @Idempotent()
  async create(@Body() body: { amount: string }) {
    state.runs += 1;
    const run = state.runs;
    await pay(`payment ${run}`);
    if (state.hold) {
      const { inside, gate } = state.hold;
      state.hold = undefined;
      inside.resolve();
      await gate.promise;
    }
    if (state.failNext) {
      state.failNext = false;
      throw new DomainError('PAYMENT_DECLINED', 'The payment was declined.', {
        kind: 'conflict',
      });
    }
    return { paymentId: `pay-${run}`, amount: body.amount };
  }

  @Post(':id/capture')
  @HttpCode(202)
  @Idempotent()
  async capture(@Param('id') id: string, @Query('mode') mode?: string) {
    state.runs += 1;
    await pay(`capture ${id}`);
    return { captured: id, mode: mode ?? 'full' };
  }

  @Put(':id')
  @Idempotent()
  async replace(@Param('id') id: string) {
    state.runs += 1;
    return { replaced: id };
  }

  @Delete(':id')
  @HttpCode(204)
  @Idempotent()
  async remove() {
    state.runs += 1;
  }

  @Post('webhook')
  @IdempotencyExempt('deduplicated on the provider reference')
  async webhook() {
    state.runs += 1;
    return { received: true };
  }

  @Patch('undeclared')
  async undeclared() {
    state.runs += 1;
    return { ran: true };
  }

  @Get(':id')
  async find(@Param('id') id: string) {
    state.runs += 1;
    return { id };
  }
}

describeWithPostgres('@Idempotent() over HTTP', () => {
  let schema: TestSchema<ReturnType<typeof define>>;
  let database: Database;
  let app: INestApplication;
  let memory: MemoryLogger;

  const http = () => request(app.getHttpServer());

  const payments = async (): Promise<string[]> => {
    const result = await schema.admin.query<{ note: string }>(
      `select note from ${schema.name}.payments order by id`,
    );
    return result.rows.map((row) => row.note);
  };

  const create = (
    key: string | undefined,
    body: object = { amount: '100.00' },
  ) => {
    const call = http().post('/payments').send(body);
    return key === undefined ? call : call.set('Idempotency-Key', key);
  };

  beforeAll(async () => {
    schema = await createTestSchema({
      adminUrl: adminUrl as string,
      prefix: 'idemhttp',
      define,
    });
    state.schema = schema;
    database = createDatabase({
      url: schema.appUrl,
      name: 'platform-nest-idempotent-spec',
      maxConnections: 5,
    });
    memory = createMemoryLogger();

    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.register(memory.logger)],
      controllers: [PaymentsController],
      providers: [
        {
          provide: IDEMPOTENCY,
          useValue: createIdempotency({ database, table: schema.tables.keys }),
        },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    setupHttpApp(app, { logger: memory.logger });
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await database?.close();
    await schema?.drop();
  });

  beforeEach(async () => {
    await schema.truncate('idempotency_keys', 'payments');
    state.runs = 0;
    state.hold = undefined;
    state.failNext = false;
    memory.clear();
  });

  describe('missing key', () => {
    it.failing(
      'answers 400 with problem details, and does not run the handler',
      async () => {
        const response = await create(undefined).expect(400);
        expect(response.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(JSON.parse(response.text)).toMatchObject({
          status: 400,
          code: 'IDEMPOTENCY_KEY_MISSING',
        });
        expect(state.runs).toBe(0);
        expect(await payments()).toEqual([]);
      },
    );
  });

  describe('first use and replay', () => {
    it.failing(
      'runs the handler and answers normally, without the replay header',
      async () => {
        const response = await create('key-1').expect(201);
        expect(response.body).toEqual({ paymentId: 'pay-1', amount: '100.00' });
        expect(response.headers['idempotent-replayed']).toBeUndefined();
        expect(await payments()).toEqual(['payment 1']);
      },
    );

    it.failing(
      'replays the stored response with Idempotent-Replayed: true',
      async () => {
        const first = await create('key-1').expect(201);
        const second = await create('key-1').expect(201);
        const third = await create('key-1').expect(201);

        expect(second.body).toEqual(first.body);
        expect(third.body).toEqual(first.body);
        expect(second.headers['idempotent-replayed']).toBe('true');
        expect(third.headers['idempotent-replayed']).toBe('true');
        expect(state.runs).toBe(1);
        expect(await payments()).toEqual(['payment 1']);
      },
    );

    it.failing(
      'replays the status code of a handler with its own',
      async () => {
        const first = await http()
          .post('/payments/p1/capture')
          .set('Idempotency-Key', 'key-1')
          .expect(202);
        const replay = await http()
          .post('/payments/p1/capture')
          .set('Idempotency-Key', 'key-1')
          .expect(202);
        expect(replay.body).toEqual(first.body);
        expect(replay.headers['idempotent-replayed']).toBe('true');
        expect(state.runs).toBe(1);
      },
    );

    it.failing('replays an empty 204 answer', async () => {
      await http()
        .delete('/payments/p1')
        .set('Idempotency-Key', 'key-1')
        .expect(204);
      const replay = await http()
        .delete('/payments/p1')
        .set('Idempotency-Key', 'key-1')
        .expect(204);
      expect(replay.text).toBe('');
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(state.runs).toBe(1);
    });

    it.failing('covers PUT as well as POST and DELETE', async () => {
      await http()
        .put('/payments/p1')
        .set('Idempotency-Key', 'key-1')
        .expect(200);
      await http()
        .put('/payments/p1')
        .set('Idempotency-Key', 'key-1')
        .expect(200);
      expect(state.runs).toBe(1);
      await http().put('/payments/p1').expect(400);
    });
  });

  describe('a key reused for something else', () => {
    it.failing('answers 422 when the body differs', async () => {
      await create('key-1', { amount: '100.00' }).expect(201);
      const response = await create('key-1', { amount: '999.00' }).expect(422);
      expect(JSON.parse(response.text)).toMatchObject({
        status: 422,
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      expect(state.runs).toBe(1);
      expect(await payments()).toEqual(['payment 1']);
    });

    it.failing('answers 422 when the path parameter differs', async () => {
      await http()
        .post('/payments/p1/capture')
        .set('Idempotency-Key', 'key-1')
        .expect(202);
      await http()
        .post('/payments/p2/capture')
        .set('Idempotency-Key', 'key-1')
        .expect(422);
      expect(state.runs).toBe(1);
    });

    it.failing('answers 422 when the query differs', async () => {
      await http()
        .post('/payments/p1/capture?mode=full')
        .set('Idempotency-Key', 'key-1')
        .expect(202);
      await http()
        .post('/payments/p1/capture?mode=partial')
        .set('Idempotency-Key', 'key-1')
        .expect(422);
      expect(state.runs).toBe(1);
    });

    it.failing(
      'answers 422 when the same key is sent to another route',
      async () => {
        await create('key-1').expect(201);
        await http()
          .put('/payments/p1')
          .set('Idempotency-Key', 'key-1')
          .expect(422);
        expect(state.runs).toBe(1);
      },
    );
  });

  describe('a request still in flight', () => {
    it.failing(
      'answers 409 with Retry-After to a second request with the same key',
      async () => {
        const hold = { inside: deferred(), gate: deferred() };
        state.hold = hold;
        const first = create('key-1').then((response) => response);
        // If the first request ends before reaching the handler, fail now instead of waiting.
        await Promise.race([
          hold.inside.promise,
          first.then(() => {
            throw new Error(
              'the first request ended without entering the handler',
            );
          }),
        ]);

        try {
          const second = await create('key-1').expect(409);
          expect(JSON.parse(second.text)).toMatchObject({
            status: 409,
            code: 'IDEMPOTENCY_IN_FLIGHT',
          });
          expect(second.headers['retry-after']).toBeDefined();
        } finally {
          // Whatever happened above, let the first request finish, so a
          // failure here cannot leave a transaction open behind it.
          hold.gate.resolve();
        }
        expect((await first).status).toBe(201);
        expect(state.runs).toBe(1);

        const replay = await create('key-1').expect(201);
        expect(replay.headers['idempotent-replayed']).toBe('true');
        expect(await payments()).toEqual(['payment 1']);
      },
    );
  });

  describe('a handler that fails', () => {
    it.failing(
      "answers with the handler's own error, stores nothing, and lets the key retry",
      async () => {
        state.failNext = true;
        const failed = await create('key-1').expect(409);
        expect(JSON.parse(failed.text)).toMatchObject({
          code: 'PAYMENT_DECLINED',
        });
        expect(failed.headers['idempotent-replayed']).toBeUndefined();
        // The write the handler made before failing is rolled back with it.
        expect(await payments()).toEqual([]);

        const retry = await create('key-1').expect(201);
        expect(retry.body).toEqual({ paymentId: 'pay-2', amount: '100.00' });
        expect(retry.headers['idempotent-replayed']).toBeUndefined();
        expect(await payments()).toEqual(['payment 2']);
        expect(state.runs).toBe(2);
      },
    );
  });

  describe('handlers that are not @Idempotent()', () => {
    it.failing(
      'lets an exempt handler run without a key, every time',
      async () => {
        await http().post('/payments/webhook').expect(201);
        await http().post('/payments/webhook').expect(201);
        expect(state.runs).toBe(2);
      },
    );

    it.failing('leaves reads alone', async () => {
      const response = await http().get('/payments/p1').expect(200);
      expect(response.body).toEqual({ id: 'p1' });
      expect(response.headers['idempotent-replayed']).toBeUndefined();
    });

    it.failing(
      'refuses to run a write handler that declares nothing, and logs why',
      async () => {
        const response = await http()
          .patch('/payments/undeclared')
          .set('Idempotency-Key', 'key-1')
          .expect(500);
        expect(JSON.parse(response.text)).toMatchObject({
          code: 'INTERNAL_ERROR',
        });
        expect(state.runs).toBe(0);
        expect(memory.entries).toContainEqual(
          expect.objectContaining({
            level: 'error',
            err: expect.objectContaining({ code: 'IDEMPOTENCY_NOT_DECLARED' }),
          }),
        );
      },
    );
  });
});

describe('findUncoveredRoutes', () => {
  @Controller('good')
  class GoodController {
    @Post()
    @Idempotent()
    create() {
      return undefined;
    }

    @Delete(':id')
    @IdempotencyExempt('soft delete is naturally idempotent')
    remove() {
      return undefined;
    }

    @Get()
    list() {
      return undefined;
    }

    /** Not a route: no HTTP method decorator. */
    helper() {
      return undefined;
    }
  }

  @Controller('bad')
  class BadController {
    @Post()
    create() {
      return undefined;
    }

    @Put(':id')
    replace() {
      return undefined;
    }

    @Patch(':id')
    @Idempotent()
    @IdempotencyExempt('cannot be both')
    change() {
      return undefined;
    }

    @Delete(':id')
    @IdempotencyExempt('   ')
    remove() {
      return undefined;
    }

    @Get(':id')
    find() {
      return undefined;
    }
  }

  it.failing(
    'is empty when every write handler declares its idempotency',
    () => {
      expect(findUncoveredRoutes([GoodController])).toEqual([]);
    },
  );

  it.failing(
    'lists write handlers that declare nothing, both, or an empty reason',
    () => {
      expect(findUncoveredRoutes([GoodController, BadController])).toEqual([
        {
          controller: 'BadController',
          handler: 'create',
          method: 'POST',
          problem: 'has neither @Idempotent() nor @IdempotencyExempt(reason)',
        },
        {
          controller: 'BadController',
          handler: 'replace',
          method: 'PUT',
          problem: 'has neither @Idempotent() nor @IdempotencyExempt(reason)',
        },
        {
          controller: 'BadController',
          handler: 'change',
          method: 'PATCH',
          problem: 'has both @Idempotent() and @IdempotencyExempt(reason)',
        },
        {
          controller: 'BadController',
          handler: 'remove',
          method: 'DELETE',
          problem: '@IdempotencyExempt needs a reason',
        },
      ]);
    },
  );

  it.failing(
    'finds the write handlers of the controller used in the HTTP tests',
    () => {
      expect(findUncoveredRoutes([PaymentsController])).toEqual([
        {
          controller: 'PaymentsController',
          handler: 'undeclared',
          method: 'PATCH',
          problem: 'has neither @Idempotent() nor @IdempotencyExempt(reason)',
        },
      ]);
    },
  );
});
