import { Client } from 'pg';
import {
  acquireObjectStore,
  acquirePostgres,
  acquireRedis,
  containersEnabled,
  objectStoreAvailable,
  startObjectStoreContainer,
  startPostgresContainer,
  startRedisContainer,
  type StartedService,
} from './containers';
import { createTestSchema } from './postgres-test-schema';

/**
 * These start real Docker containers, so they run only when
 * HK_TEST_CONTAINERS=1 (CI sets it). They need a running Docker daemon.
 */
const describeWithDocker = containersEnabled() ? describe : describe.skip;

describe('test setup', () => {
  it('may start containers when running in CI', () => {
    if (process.env['CI']) {
      expect(containersEnabled()).toBe(true);
    }
  });
});

describe('acquire', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('uses the configured server, and stop() leaves it running', async () => {
    process.env['HK_TEST_DATABASE_URL'] = 'postgres://configured/db';
    process.env['HK_TEST_REDIS_URL'] = 'redis://configured:6379';
    const postgres = await acquirePostgres();
    const redis = await acquireRedis();
    expect(postgres?.url).toBe('postgres://configured/db');
    expect(redis?.url).toBe('redis://configured:6379');
    await expect(postgres?.stop()).resolves.toBeUndefined();
  });

  it('gives nothing when no server is configured and containers are off', async () => {
    delete process.env['HK_TEST_DATABASE_URL'];
    delete process.env['HK_TEST_REDIS_URL'];
    delete process.env['HK_TEST_S3_ENDPOINT'];
    delete process.env['HK_TEST_CONTAINERS'];
    expect(await acquirePostgres()).toBeUndefined();
    expect(await acquireRedis()).toBeUndefined();
    expect(await acquireObjectStore()).toBeUndefined();
    expect(objectStoreAvailable()).toBe(false);
  });

  it('uses the configured object store, with test credentials unless others are given', async () => {
    process.env['HK_TEST_S3_ENDPOINT'] = 'http://configured:9090';
    delete process.env['HK_TEST_S3_ACCESS_KEY'];
    delete process.env['HK_TEST_S3_SECRET_KEY'];
    delete process.env['HK_TEST_S3_REGION'];
    expect(objectStoreAvailable()).toBe(true);
    const store = await acquireObjectStore();
    expect(store).toMatchObject({
      endpoint: 'http://configured:9090',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
    await expect(store?.stop()).resolves.toBeUndefined();

    process.env['HK_TEST_S3_ACCESS_KEY'] = 'other-key';
    process.env['HK_TEST_S3_SECRET_KEY'] = 'other-secret';
    process.env['HK_TEST_S3_REGION'] = 'eu-north-1';
    expect(await acquireObjectStore()).toMatchObject({
      region: 'eu-north-1',
      accessKeyId: 'other-key',
      secretAccessKey: 'other-secret',
    });
  });
});

describeWithDocker('containers', () => {
  it('starts an object store that answers on its endpoint, and removes it', async () => {
    const store = await startObjectStoreContainer();
    try {
      expect(store.endpoint).toMatch(/^http:\/\/[^:]+:\d+$/);
      const response = await fetch(store.endpoint);
      expect(response.status).toBe(200);
    } finally {
      await store.stop();
    }
  }, 180_000);

  it('starts a PostgreSQL 17 that createTestSchema can use, and removes it', async () => {
    let postgres: StartedService | undefined;
    try {
      postgres = await startPostgresContainer();
      const client = new Client({ connectionString: postgres.url });
      await client.connect();
      const version = await client.query<{ server_version: string }>(
        'show server_version',
      );
      await client.end();
      expect(version.rows[0]?.server_version).toMatch(/^17\./);

      // The URL is a superuser URL: the schema helper can create its roles.
      const schema = await createTestSchema({
        adminUrl: postgres.url,
        prefix: 'container',
        define: () => ({}),
      });
      await schema.drop();
    } finally {
      await postgres?.stop();
    }
  }, 180_000);

  it('starts a Redis 7 that answers, and removes it', async () => {
    let redis: StartedService | undefined;
    const { Redis } = await import('ioredis');
    try {
      redis = await startRedisContainer();
      const client = new Redis(redis.url, { maxRetriesPerRequest: 2 });
      try {
        expect(await client.ping()).toBe('PONG');
        const info = await client.info('server');
        expect(info).toMatch(/redis_version:7\./);
      } finally {
        client.disconnect();
      }
    } finally {
      await redis?.stop();
    }
  }, 180_000);
});
