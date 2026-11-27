/**
 * Throwaway PostgreSQL and Redis servers in Docker, through Testcontainers.
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
