import { createMemoryLogger } from '@hk/platform/logger';
import {
  closeRedis,
  createKeyBuilder,
  createRedis,
  pingRedis,
  type RedisClient,
} from './redis';

/**
 * Tests that need a server run when HK_TEST_REDIS_URL is set:
 *   pnpm infra:up
 *   HK_TEST_REDIS_URL=redis://127.0.0.1:63790 pnpm nx test platform-redis
 */
const url = process.env['HK_TEST_REDIS_URL'];
const describeWithRedis = url ? describe : describe.skip;

describe('test setup', () => {
  it('has a Redis to test against when running in CI', () => {
    if (process.env['CI']) {
      expect(url).toBeDefined();
    }
  });
});

describe('createRedis', () => {
  it.each(['http://localhost:6379', 'localhost:6379', '', 'not a url'])(
    'refuses %p without echoing it',
    (bad) => {
      expect(() => createRedis({ url: bad, name: 'x' })).toThrow(
        'Redis URL must start with redis:// or rediss://.',
      );
    },
  );

  it('never puts the URL or its password in an error or a log line', async () => {
    const { logger, text } = createMemoryLogger();
    // Port 1 refuses connections, so this exercises the error path.
    const client = createRedis({
      url: 'redis://:sup3r-s3cret@127.0.0.1:1',
      name: 'spec-unreachable',
      logger,
      connectTimeoutMs: 200,
    });
    await new Promise((resolve) => client.once('error', resolve));
    await closeRedis(client, 100);

    expect(text()).toContain('redis connection error');
    expect(text()).toContain('spec-unreachable');
    expect(text()).not.toContain('sup3r-s3cret');
  });

  it('does not crash the process when Redis is unreachable', async () => {
    const client = createRedis({
      url: 'redis://127.0.0.1:1',
      name: 'spec-unreachable',
      connectTimeoutMs: 200,
    });
    await new Promise((resolve) => client.once('error', resolve));
    await expect(pingRedis(client)).rejects.toThrow();
    await closeRedis(client, 100);
    expect(client.status).toBe('end');
  });
});

describe('createKeyBuilder', () => {
  it('namespaces keys by service', () => {
    const key = createKeyBuilder('sales');
    expect(key('rate-limit', 'tenant-1', 'login')).toBe(
      'hk:sales:rate-limit:tenant-1:login',
    );
    expect(key('018f2c3a-7b1e-7000-8000-000000000001')).toBe(
      'hk:sales:018f2c3a-7b1e-7000-8000-000000000001',
    );
  });

  it('refuses parts that could break out of the namespace', () => {
    const key = createKeyBuilder('sales');
    for (const bad of ['a:b', '', 'a b', 'a*', 'a\nb']) {
      expect(() => key('ok', bad)).toThrow(/key parts/);
    }
    expect(() => key()).toThrow(/key parts/);
    expect(() => createKeyBuilder('sales:core')).toThrow(/service name/);
  });
});

describeWithRedis('against a real Redis', () => {
  let client: RedisClient;
  const key = createKeyBuilder('spec');

  beforeAll(() => {
    client = createRedis({ url: url as string, name: 'platform-redis-spec' });
  });

  afterAll(async () => {
    await closeRedis(client);
  });

  it('connects, answers a ping and reports its name to the server', async () => {
    await expect(pingRedis(client)).resolves.toBeUndefined();
    await expect(client.client('GETNAME')).resolves.toBe('platform-redis-spec');
  });

  it('reads back what it wrote', async () => {
    const name = key('roundtrip', String(Date.now()));
    await client.set(name, 'value', 'EX', 30);
    await expect(client.get(name)).resolves.toBe('value');
    await client.del(name);
  });

  it('logs when the connection is ready', async () => {
    const { logger, entries } = createMemoryLogger();
    const second = createRedis({
      url: url as string,
      name: 'platform-redis-spec-2',
      logger,
    });
    await pingRedis(second);
    await closeRedis(second);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'redis connection ready',
        connection: 'platform-redis-spec-2',
      }),
    );
  });

  it('closes cleanly and can be closed twice', async () => {
    const second = createRedis({ url: url as string, name: 'spec-close' });
    await pingRedis(second);
    await closeRedis(second);
    expect(second.status).toBe('end');
    await expect(closeRedis(second)).resolves.toBeUndefined();
  });

  it('keeps commands waiting on a queue connection, as BullMQ requires', async () => {
    const queueConnection = createRedis({
      url: url as string,
      name: 'spec-queue',
      purpose: 'queue',
    });
    expect(queueConnection.options.maxRetriesPerRequest).toBeNull();
    expect(client.options.maxRetriesPerRequest).toBe(3);
    await closeRedis(queueConnection);
  });
});
