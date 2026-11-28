/**
 * Throwaway PostgreSQL, Redis and object storage servers in Docker, through
 * Testcontainers.
 *
 * Use them where a test needs a server and none is provided. CI and the
 * usual local run provide one through HK_TEST_DATABASE_URL and
 * HK_TEST_REDIS_URL (see `pnpm infra:up`), which is faster than starting a
 * container per test file. So the helpers below only start a container when
 * no URL is configured and containers are switched on with
 * HK_TEST_CONTAINERS=1.
 */

export interface StartedService {
  /** Connection URL. For PostgreSQL it is a superuser URL, as createTestSchema needs. */
  url: string;
  /** Stops and removes the container. A no-op for a server this helper did not start. */
  stop(): Promise<void>;
}

export const POSTGRES_IMAGE = 'postgres:17-alpine';
export const REDIS_IMAGE = 'redis:7-alpine';
/**
 * Adobe S3Mock: a server that speaks the S3 API, made for testing S3 clients.
 * Pinned by digest so every run uses the same server.
 */
export const S3_IMAGE =
  'adobe/s3mock@sha256:ab01a6946750f451ca215a47e91030695b260e4003b8a5a6201d25029b8fca92';
const S3_PORT = 9090;

/** An S3-compatible object store to test against. */
export interface StartedObjectStore {
  /** For example "http://127.0.0.1:9090". */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Stops and removes the container. A no-op for a server this helper did not start. */
  stop(): Promise<void>;
}

/** True when HK_TEST_CONTAINERS=1: tests may start Docker containers. */
export const containersEnabled = (): boolean =>
  process.env['HK_TEST_CONTAINERS'] === '1';

/** Starts PostgreSQL in a container. Needs a running Docker daemon. */
export const startPostgresContainer = async (
  image = POSTGRES_IMAGE,
): Promise<StartedService> => {
  // Imported on demand: Testcontainers is heavy, and most test files never start one.
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer(image)
    .withDatabase('hk')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
};

/** Starts Redis in a container. Needs a running Docker daemon. */
export const startRedisContainer = async (
  image = REDIS_IMAGE,
): Promise<StartedService> => {
  const { RedisContainer } = await import('@testcontainers/redis');
  const container = await new RedisContainer(image).start();
  return {
    url: container.getConnectionUrl(),
    stop: async () => {
      await container.stop();
    },
  };
};

const provided = (url: string): StartedService => ({
  url,
  stop: async () => undefined,
});

/**
 * A PostgreSQL to test against: the one in HK_TEST_DATABASE_URL when set,
 * otherwise a new container when HK_TEST_CONTAINERS=1, otherwise undefined,
 * in which case the caller skips its server-dependent tests.
 */
export const acquirePostgres = async (): Promise<
  StartedService | undefined
> => {
  const url = process.env['HK_TEST_DATABASE_URL'];
  if (url) {
    return provided(url);
  }
  return containersEnabled() ? startPostgresContainer() : undefined;
};

/** The same for Redis, with HK_TEST_REDIS_URL. */
export const acquireRedis = async (): Promise<StartedService | undefined> => {
  const url = process.env['HK_TEST_REDIS_URL'];
  if (url) {
    return provided(url);
  }
  return containersEnabled() ? startRedisContainer() : undefined;
};

/** Starts an S3-compatible object store in a container. Needs a running Docker daemon. */
export const startObjectStoreContainer = async (
  image = S3_IMAGE,
): Promise<StartedObjectStore> => {
  const { GenericContainer, Wait } = await import('testcontainers');
  const container = await new GenericContainer(image)
    .withExposedPorts(S3_PORT)
    .withWaitStrategy(Wait.forHttp('/', S3_PORT).forStatusCode(200))
    .start();
  return {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(S3_PORT)}`,
    // The mock accepts any region and any credentials. These are not secrets.
    region: 'us-east-1',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    stop: async () => {
      await container.stop();
    },
  };
};

/**
 * An object store to test against: the one at HK_TEST_S3_ENDPOINT when set
 * (see `pnpm infra:up`), otherwise a new container when HK_TEST_CONTAINERS=1,
 * otherwise undefined, in which case the caller skips its tests.
 */
export const acquireObjectStore = async (): Promise<
  StartedObjectStore | undefined
> => {
  const endpoint = process.env['HK_TEST_S3_ENDPOINT'];
  if (endpoint) {
    return {
      endpoint,
      region: process.env['HK_TEST_S3_REGION'] || 'us-east-1',
      accessKeyId: process.env['HK_TEST_S3_ACCESS_KEY'] || 'test',
      secretAccessKey: process.env['HK_TEST_S3_SECRET_KEY'] || 'test',
      stop: async () => undefined,
    };
  }
  return containersEnabled() ? startObjectStoreContainer() : undefined;
};

/** True when an object store is configured or may be started. */
export const objectStoreAvailable = (): boolean =>
  Boolean(process.env['HK_TEST_S3_ENDPOINT']) || containersEnabled();
