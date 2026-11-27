import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMemoryLogger } from '@hk/platform/logger';
import { Money } from '@hk/platform/universal';
import {
  HttpClientError,
  createHttpClient,
  type HttpClient,
  type HttpClientOptions,
} from './http-client';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

type Reply = (response: ServerResponse, seen: Seen) => void;

const json =
  (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): Reply =>
  (response) => {
    response.writeHead(status, {
      'content-type': 'application/json',
      ...headers,
    });
    response.end(JSON.stringify(body));
  };

const problem =
  (status: number, code: string): Reply =>
  (response) => {
    response.writeHead(status, { 'content-type': 'application/problem+json' });
    response.end(
      JSON.stringify({ type: 'about:blank', title: 'T', status, code }),
    );
  };

/** Never answers, so the client's timeout fires. */
const hang: Reply = () => undefined;

const failure = async (action: Promise<unknown>): Promise<HttpClientError> => {
  try {
    await action;
  } catch (error) {
    if (error instanceof HttpClientError) {
      return error;
    }
    throw error;
  }
  throw new Error('the call did not fail');
};

describe('createHttpClient', () => {
  let server: Server;
  let baseUrl: string;
  let replies: Reply[];
  let seen: Seen[];
  let sleeps: number[];

  const client = (overrides: Partial<HttpClientOptions> = {}): HttpClient =>
    createHttpClient({
      baseUrl,
      name: 'core-api',
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      ...overrides,
    });

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const entry: Seen = {
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        seen.push(entry);
        const reply = replies.shift() ?? json(500, { unexpected: true });
        reply(response, entry);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    replies = [];
    seen = [];
    sleeps = [];
  });

  describe('requests and responses', () => {
    it('sends JSON and parses the JSON answer', async () => {
      replies.push(json(201, { id: 'inv-1' }));
      const response = await client().post<{ id: string }>('/invoices', {
        body: { total: Money.of('1500.50', 'AED') },
        idempotencyKey: 'key-1',
      });

      expect(response.status).toBe(201);
      expect(response.data).toEqual({ id: 'inv-1' });
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/invoices' });
      expect(seen[0]?.headers).toMatchObject({
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': 'key-1',
      });
      // Money crosses the wire as strings, never as a JS number.
      expect(seen[0]?.body).toBe(
        '{"total":{"amount":"1500.5","currency":"AED"}}',
      );
    });

    it('builds the query string, skipping undefined values', async () => {
      replies.push(json(200, []));
      await client().get('/invoices', {
        query: { status: 'open', page: 2, archived: false, q: undefined },
      });
      expect(seen[0]?.url).toBe('/invoices?status=open&page=2&archived=false');
    });

    it('keeps a path prefix from the base URL', async () => {
      replies.push(json(200, {}));
      await client({ baseUrl: `${baseUrl}/v1/` }).get('/accounts');
      expect(seen[0]?.url).toBe('/v1/accounts');
    });

    it('returns undefined for an empty answer and text for a non-JSON one', async () => {
      replies.push((response) => response.writeHead(204).end());
      replies.push((response) =>
        response.writeHead(200, { 'content-type': 'text/plain' }).end('pong'),
      );
      await expect(
        client().delete('/x', { idempotencyKey: 'k' }),
      ).resolves.toMatchObject({
        status: 204,
        data: undefined,
      });
      await expect(client().get('/ping')).resolves.toMatchObject({
        data: 'pong',
      });
    });

    it('adds context headers on every attempt, and lets a request override them', async () => {
      replies.push(json(503, {}), json(200, {}));
      let calls = 0;
      await client({
        headers: () => {
          calls += 1;
          return { 'x-request-id': 'req-1', traceparent: `trace-${calls}` };
        },
      }).get('/x', { headers: { 'x-request-id': 'override' } });

      expect(seen.map((entry) => entry.headers['traceparent'])).toEqual([
        'trace-1',
        'trace-2',
      ]);
      expect(seen[0]?.headers['x-request-id']).toBe('override');
    });

    it.each(['invoices', '//evil.example/x', 'http://evil.example/x'])(
      'refuses the path %p, so the host always comes from baseUrl',
      async (path) => {
        await expect(client().get(path)).rejects.toThrow(/single "\/"/);
        expect(seen).toHaveLength(0);
      },
    );
  });

  describe('error responses', () => {
    it('throws with the problem details the server sent', async () => {
      replies.push(problem(409, 'INVOICE_ALREADY_ISSUED'));
      const error = await failure(
        client().post('/invoices/1/issue', { idempotencyKey: 'k' }),
      );
      expect(error).toMatchObject({
        name: 'HttpClientError',
        client: 'core-api',
        method: 'POST',
        path: '/invoices/1/issue',
        code: 'HTTP_RESPONSE',
        status: 409,
        attempts: 1,
        outcomeUnknown: false,
        problem: { code: 'INVOICE_ALREADY_ISSUED', status: 409 },
      });
    });

    it('has no problem when the error body is something else', async () => {
      replies.push(json(404, { message: 'nope' }));
      const error = await failure(client().get('/missing'));
      expect(error.status).toBe(404);
      expect(error.problem).toBeUndefined();
    });

    it('keeps the query string, headers and bodies out of the error', async () => {
      replies.push(json(400, { echoed: 'body-secret' }));
      const error = await failure(
        client().post('/login', {
          query: { phone: '677123456' },
          body: { otp: '424242' },
          headers: { authorization: 'Bearer header-secret' },
        }),
      );
      const text = `${error.message} ${JSON.stringify(error)} ${error.stack}`;
      expect(error.path).toBe('/login');
      for (const secret of [
        '677123456',
        '424242',
        'header-secret',
        'body-secret',
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('reports an answer that claims JSON but is not', async () => {
      replies.push((response) =>
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end('<html>'),
      );
      const error = await failure(client({ retries: 0 }).get('/x'));
      expect(error.code).toBe('HTTP_INVALID_RESPONSE');
    });
  });

  describe('retries', () => {
    it.each([429, 502, 503, 504])(
      'repeats a GET after a %i',
      async (status) => {
        replies.push(json(status, {}), json(200, { ok: true }));
        const response = await client().get('/x');
        expect(response.data).toEqual({ ok: true });
        expect(seen).toHaveLength(2);
        expect(sleeps).toHaveLength(1);
      },
    );

    it.each([400, 401, 403, 404, 409, 422, 500])(
      'does not repeat after a %i',
      async (status) => {
        replies.push(json(status, {}));
        const error = await failure(client().get('/x'));
        expect(error.status).toBe(status);
        expect(seen).toHaveLength(1);
      },
    );

    it('gives up after the configured number of retries', async () => {
      replies.push(json(503, {}), json(503, {}), json(503, {}), json(200, {}));
      const error = await failure(client().get('/x'));
      expect(error).toMatchObject({ status: 503, attempts: 3 });
      expect(seen).toHaveLength(3);
    });

    it('backs off exponentially, with jitter', async () => {
      replies.push(json(503, {}), json(503, {}), json(503, {}), json(200, {}));
      await client({ retries: 3 }).get('/x');
      expect(sleeps).toHaveLength(3);
      expect(sleeps[0]).toBeGreaterThanOrEqual(50);
      expect(sleeps[0]).toBeLessThanOrEqual(100);
      expect(sleeps[1]).toBeGreaterThanOrEqual(100);
      expect(sleeps[1]).toBeLessThanOrEqual(200);
      expect(sleeps[2]).toBeGreaterThanOrEqual(200);
      expect(sleeps[2]).toBeLessThanOrEqual(400);
    });

    it('waits as long as Retry-After says, up to 10 seconds', async () => {
      replies.push(
        json(429, {}, { 'retry-after': '3' }),
        json(429, {}, { 'retry-after': '3600' }),
        json(200, {}),
      );
      await client().get('/x');
      expect(sleeps).toEqual([3_000, 10_000]);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
      'sends a %s without an idempotency key once only',
      async (method) => {
        replies.push(json(503, {}), json(200, {}));
        const error = await failure(
          client().request(method, '/x', { body: {} }),
        );
        expect(error.attempts).toBe(1);
        expect(seen).toHaveLength(1);
      },
    );

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
      'repeats a %s that has an idempotency key, with the same key',
      async (method) => {
        replies.push(json(503, {}), json(200, { ok: true }));
        await client().request(method, '/x', {
          body: {},
          idempotencyKey: 'sales:invoice:1:issue',
        });
        expect(seen.map((entry) => entry.headers['idempotency-key'])).toEqual([
          'sales:invoice:1:issue',
          'sales:invoice:1:issue',
        ]);
      },
    );

    it('logs a retry without the query string', async () => {
      const { logger, entries, text } = createMemoryLogger();
      replies.push(json(503, {}), json(200, {}));
      await client({ logger }).get('/contacts', {
        query: { phone: '677123456' },
      });
      expect(entries[0]).toMatchObject({
        level: 'debug',
        message: 'http request failed, retrying',
        client: 'core-api',
        method: 'GET',
        path: '/contacts',
        attempt: 1,
        status: 503,
      });
      expect(text()).not.toContain('677123456');
    });
  });

  describe('timeouts and broken connections', () => {
    it('times out, and repeats a read', async () => {
      replies.push(hang, json(200, { ok: true }));
      const response = await client({ timeoutMs: 80 }).get('/slow');
      expect(response.data).toEqual({ ok: true });
      expect(seen).toHaveLength(2);
    });

    it('reports a timed-out write as outcome unknown, and does not repeat it', async () => {
      replies.push(hang);
      const error = await failure(
        client({ timeoutMs: 80 }).post('/payments', {
          body: { amount: '100' },
        }),
      );
      expect(error).toMatchObject({
        code: 'HTTP_TIMEOUT',
        status: 0,
        attempts: 1,
        outcomeUnknown: true,
      });
      expect(seen).toHaveLength(1);
    });

    it('reports a timed-out read as a plain failure', async () => {
      replies.push(hang);
      const error = await failure(
        client({ timeoutMs: 80, retries: 0 }).get('/x'),
      );
      expect(error).toMatchObject({
        code: 'HTTP_TIMEOUT',
        outcomeUnknown: false,
      });
    });

    it('reports a 5xx on a write as outcome unknown, but not a 4xx', async () => {
      replies.push(json(500, {}), json(422, {}));
      const serverError = await failure(
        client().post('/payments', { body: {} }),
      );
      const rejected = await failure(client().post('/payments', { body: {} }));
      expect(serverError.outcomeUnknown).toBe(true);
      expect(rejected.outcomeUnknown).toBe(false);
    });

    it('reports a dropped connection as a network error', async () => {
      replies.push((response) => response.destroy());
      const error = await failure(client().post('/payments', { body: {} }));
      expect(error).toMatchObject({
        code: 'HTTP_NETWORK',
        status: 0,
        outcomeUnknown: true,
      });
    });

    it('reports an unreachable host as a network error after retrying', async () => {
      const error = await failure(
        client({ baseUrl: 'http://127.0.0.1:1' }).get('/x'),
      );
      expect(error).toMatchObject({ code: 'HTTP_NETWORK', attempts: 3 });
    });

    it('stops at once when the caller cancels, without retrying', async () => {
      replies.push(hang);
      const controller = new AbortController();
      const pending = failure(
        client().get('/slow', { signal: controller.signal }),
      );
      setTimeout(() => controller.abort(), 30);
      const error = await pending;
      expect(error).toMatchObject({ code: 'HTTP_ABORTED', attempts: 1 });
      expect(sleeps).toHaveLength(0);
    });
  });
});
