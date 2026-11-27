import { tooManyRequests } from '@hk/platform/errors';
import {
  createMemoryLogger,
  type Logger,
  type MemoryLogger,
} from '@hk/platform/logger';
import {
  HealthRegistry,
  createHttpServerMetrics,
  createMetrics,
} from '@hk/platform/observability';
import { DomainError, isUuidV7 } from '@hk/platform/universal';
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { LoggerModule, NestLoggerAdapter } from './logger.module';
import { ObservabilityModule } from './observability.module';
import { RequestId } from './request-context';
import { setupHttpApp } from './setup-http-app';
import { LOGGER } from './tokens';
import { ZodValidationPipe } from './zod-validation.pipe';

const createThing = z.object({
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  note: z.string().default('none'),
});

@Controller('things')
class ThingsController {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  @Get('conflict')
  conflict(): never {
    throw new DomainError('THING_ALREADY_ISSUED', 'The thing is issued.', {
      kind: 'conflict',
      details: { status: 'ISSUED' },
    });
  }

  @Get('invariant')
  invariant(): never {
    throw new DomainError('MONEY_CURRENCY_MISMATCH', 'XAF and AED mixed.', {
      kind: 'invariant',
      details: { left: 'XAF', right: 'AED' },
    });
  }

  @Get('crash')
  crash(): never {
    throw new Error('connect failed for postgres://sales:hunter2@db/hk');
  }

  @Get('busy')
  busy(): never {
    throw tooManyRequests(5);
  }

  @Get(':id')
  find(@Param('id') id: string, @RequestId() requestId: string) {
    this.logger.info('thing loaded');
    return { id, requestId };
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createThing))
    input: z.output<typeof createThing>,
  ) {
    return input;
  }
}

describe('platform/nest on an HTTP app', () => {
  let app: INestApplication;
  let memory: MemoryLogger;
  let databaseUp: boolean;

  const http = () => request(app.getHttpServer());
  const lines = (message: string) =>
    memory.entries.filter((entry) => entry.message === message);

  beforeAll(async () => {
    memory = createMemoryLogger();
    const metrics = createMetrics({ service: 'spec', processMetrics: false });
    const health = new HealthRegistry()
      .register({ name: 'process', kind: 'liveness', check: () => undefined })
      .register({
        name: 'postgres',
        kind: 'readiness',
        check: () => {
          if (!databaseUp) {
            throw new Error('password authentication failed');
          }
        },
      });

    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.register(memory.logger),
        ObservabilityModule.register({ health, metrics }),
      ],
      controllers: [ThingsController],
    }).compile();

    app = moduleRef.createNestApplication({
      logger: new NestLoggerAdapter(memory.logger),
    });
    setupHttpApp(app, {
      logger: memory.logger,
      metrics: createHttpServerMetrics(metrics),
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    memory.clear();
    databaseUp = true;
  });

  describe('request id', () => {
    it('creates one, returns it in a header and passes it to the handler', async () => {
      const response = await http().get('/things/42').expect(200);
      const requestId = response.headers['x-request-id'] as string;
      expect(isUuidV7(requestId)).toBe(true);
      expect(response.body).toEqual({ id: '42', requestId });
    });

    it('keeps an acceptable id from the caller', async () => {
      const response = await http()
        .get('/things/42')
        .set('X-Request-Id', 'gateway-abc-123')
        .expect(200);
      expect(response.headers['x-request-id']).toBe('gateway-abc-123');
    });

    it.each([
      'short',
      'has spaces in it',
      'x'.repeat(129),
      'line\\nbreak-injection',
    ])('replaces the unacceptable id %p', async (bad) => {
      const response = await http().get('/things/42').set('X-Request-Id', bad);
      expect(isUuidV7(response.headers['x-request-id'])).toBe(true);
    });

    it('is on every log line written while handling the request', async () => {
      await http().get('/things/42').set('X-Request-Id', 'gateway-abc-123');
      expect(lines('thing loaded')[0]).toMatchObject({
        requestId: 'gateway-abc-123',
      });
      expect(lines('request completed')[0]).toMatchObject({
        requestId: 'gateway-abc-123',
      });
    });
  });

  describe('request log', () => {
    it('records method, route pattern, status and duration', async () => {
      await http().get('/things/42?phone=677123456').expect(200);
      const [line] = lines('request completed');
      expect(line).toMatchObject({
        level: 'info',
        method: 'GET',
        route: '/things/:id',
        status: 200,
        durationMs: expect.any(Number),
      });
      expect(memory.text()).not.toContain('677123456');
      expect(memory.text()).not.toContain('/things/42');
    });

    it('logs a 5xx as an error and an unknown route as "unmatched"', async () => {
      await http().get('/things/crash').expect(500);
      expect(lines('request completed')[0]).toMatchObject({
        level: 'error',
        status: 500,
      });
      memory.clear();
      await http().get('/no/such/route/7781').expect(404);
      expect(lines('request completed')[0]).toMatchObject({
        route: 'unmatched',
        status: 404,
      });
    });

    it('does not log probes', async () => {
      await http().get('/health/live').expect(200);
      await http().get('/metrics').expect(200);
      expect(lines('request completed')).toHaveLength(0);
    });
  });

  describe('error responses', () => {
    it('answers a business-rule failure with problem details', async () => {
      const response = await http()
        .get('/things/conflict')
        .set('X-Request-Id', 'gateway-abc-123')
        .expect(409);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(JSON.parse(response.text)).toEqual({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'THING_ALREADY_ISSUED',
        detail: 'The thing is issued.',
        instance: '/things/conflict',
        requestId: 'gateway-abc-123',
        details: { status: 'ISSUED' },
      });
      expect(lines('request rejected')[0]).toMatchObject({
        level: 'info',
        status: 409,
        code: 'THING_ALREADY_ISSUED',
      });
    });

    it('hides an invariant failure from the caller and logs it in full', async () => {
      const response = await http().get('/things/invariant').expect(500);
      expect(JSON.parse(response.text)).toMatchObject({
        status: 500,
        code: 'INTERNAL_ERROR',
        title: 'Internal Server Error',
      });
      expect(response.text).not.toContain('XAF');
      expect(lines('request failed')[0]).toMatchObject({
        level: 'error',
        status: 500,
        err: { code: 'MONEY_CURRENCY_MISMATCH', kind: 'invariant' },
      });
    });

    it('hides an unexpected crash from the caller', async () => {
      const response = await http().get('/things/crash').expect(500);
      expect(JSON.parse(response.text)).toEqual({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        code: 'INTERNAL_ERROR',
        instance: '/things/crash',
        requestId: response.headers['x-request-id'],
      });
      expect(response.text).not.toContain('hunter2');
      expect(lines('request failed')).toHaveLength(1);
    });

    it('sends the headers an AppError carries', async () => {
      const response = await http().get('/things/busy').expect(429);
      expect(response.headers['retry-after']).toBe('5');
      expect(JSON.parse(response.text)).toMatchObject({ code: 'RATE_LIMITED' });
    });

    it('answers an unknown route with a 404 that does not quote the URL', async () => {
      const response = await http()
        .get('/no/such/route?token=abc123')
        .expect(404);
      expect(JSON.parse(response.text)).toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
        detail: 'The resource was not found.',
        instance: '/no/such/route',
      });
      expect(response.text).not.toContain('abc123');
    });

    it('answers malformed JSON with a 400', async () => {
      const response = await http()
        .post('/things')
        .set('Content-Type', 'application/json')
        .send('{"name": "x", ')
        .expect(400);
      expect(JSON.parse(response.text)).toMatchObject({
        status: 400,
        code: 'BAD_REQUEST',
      });
    });
  });

  describe('ZodValidationPipe', () => {
    it('passes the parsed value, with defaults applied and unknown keys removed', async () => {
      const response = await http()
        .post('/things')
        .send({ name: 'Widget', quantity: 3, extra: 'dropped' })
        .expect(201);
      expect(response.body).toEqual({
        name: 'Widget',
        quantity: 3,
        note: 'none',
      });
    });

    it('lists every invalid field in a 400', async () => {
      const response = await http()
        .post('/things')
        .send({ name: '', quantity: 1.5 })
        .expect(400);
      const problem = JSON.parse(response.text);
      expect(problem).toMatchObject({
        status: 400,
        code: 'REQUEST_INVALID',
        title: 'Bad Request',
      });
      expect(
        problem.errors.map((issue: { path: string }) => issue.path).sort(),
      ).toEqual(['name', 'quantity']);
      for (const issue of problem.errors) {
        expect(issue).toEqual({
          path: expect.any(String),
          code: expect.any(String),
          message: expect.any(String),
        });
      }
    });
  });

  describe('health and metrics endpoints', () => {
    it('reports liveness', async () => {
      const response = await http().get('/health/live').expect(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        checks: { process: { status: 'ok' } },
      });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('reports readiness as 200, then 503 when a dependency is down', async () => {
      await http().get('/health/ready').expect(200);
      databaseUp = false;
      const response = await http().get('/health/ready').expect(503);
      expect(response.body).toMatchObject({
        status: 'error',
        checks: { postgres: { status: 'failed' } },
      });
      expect(response.text).not.toContain('password');
    });

    it('keeps liveness green while a dependency is down', async () => {
      databaseUp = false;
      await http().get('/health/live').expect(200);
    });

    it('exposes request durations by route pattern in Prometheus format', async () => {
      await http().get('/things/42').expect(200);
      const response = await http().get('/metrics').expect(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain(
        'http_server_request_duration_seconds_count',
      );
      expect(response.text).toContain('route="/things/:id"');
      expect(response.text).not.toContain('route="/things/42"');
      expect(response.text).not.toContain('route="/metrics"');
    });
  });
});

describe('NestLoggerAdapter', () => {
  it('writes Nest messages through the platform logger with their context', () => {
    const { logger, entries } = createMemoryLogger();
    const adapter = new NestLoggerAdapter(logger);
    adapter.log('Nest application successfully started', 'NestApplication');
    adapter.warn('deprecated option', 'Config');
    adapter.debug('resolved', 'Injector');
    adapter.verbose('detail', 'Injector');
    adapter.fatal('cannot start', 'Bootstrap');
    adapter.error('boom', 'Error: boom\n    at x', 'ExceptionsHandler');
    adapter.error(new Error('raw error'));

    expect(entries.map((entry) => [entry.level, entry.message])).toEqual([
      ['info', 'Nest application successfully started'],
      ['warn', 'deprecated option'],
      ['debug', 'resolved'],
      ['trace', 'detail'],
      ['fatal', 'cannot start'],
      ['error', 'boom'],
      ['error', 'nest message'],
    ]);
    expect(entries[0]).toMatchObject({ context: 'NestApplication' });
    expect(entries[5]).toMatchObject({
      context: 'ExceptionsHandler',
      stack: expect.stringContaining('at x'),
    });
    expect(entries[6]).toMatchObject({ err: { message: 'raw error' } });
  });
});
