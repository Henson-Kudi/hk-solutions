import type { Logger } from '@hk/platform/logger';
import { Redis } from 'ioredis';

export type RedisClient = Redis;

export interface RedisConnectionOptions {
  /** redis://host:port or rediss://… for TLS. May contain a password; it is never logged. */
  url: string;
  /** Shows up in log lines and in `CLIENT LIST` on the server: "sales-cache", "sales-queue". */
  name: string;
  /**
   * commands  Normal use. A command fails after 3 retries when Redis is away,
   *           so a request gets an error instead of hanging.
   * queue     For BullMQ. Commands wait for Redis to come back, as BullMQ
   *           requires for its blocking connections.
   */
  purpose?: 'commands' | 'queue';
  logger?: Logger;
  /** Defaults to 5000. */
  connectTimeoutMs?: number;
}

const SCHEMES = ['redis:', 'rediss:'];
const MAX_RECONNECT_DELAY_MS = 5_000;

const assertRedisUrl = (url: string): void => {
  let protocol: string | undefined;
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol === undefined || !SCHEMES.includes(protocol)) {
    // The URL is not included: it can hold a password.
    throw new Error('Redis URL must start with redis:// or rediss://.');
  }
};

/**
 * Opens a Redis connection with the platform's defaults.
 *
 * The connection starts connecting at once and reconnects forever with a
 * capped back-off. It never throws for a lost connection: the service stays
 * up, its readiness check fails, and traffic returns when Redis does.
 *
 * Close it with closeRedis() during shutdown.
 */
export const createRedis = (options: RedisConnectionOptions): RedisClient => {
  assertRedisUrl(options.url);
  const { logger, name } = options;

  const client = new Redis(options.url, {
    connectionName: name,
    connectTimeout: options.connectTimeoutMs ?? 5_000,
    maxRetriesPerRequest: options.purpose === 'queue' ? null : 3,
    retryStrategy: (attempt) => Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS),
  });

  // Without an 'error' listener Node treats a connection error as an
  // uncaught exception and stops the process.
  client.on('error', (err) => {
    logger?.warn('redis connection error', { connection: name, err });
  });
  client.on('ready', () => {
    logger?.info('redis connection ready', { connection: name });
  });
  client.on('reconnecting', () => {
    logger?.debug('redis reconnecting', { connection: name });
  });
  return client;
};

/** Resolves when Redis answers. For a readiness check. */
export const pingRedis = async (client: RedisClient): Promise<void> => {
  const answer = await client.ping();
  if (answer !== 'PONG') {
    throw new Error('Redis did not answer PONG.');
  }
};

/**
 * Closes the connection. Waits for pending replies, up to `timeoutMs`
 * (default 2000), then drops the socket.
 */
export const closeRedis = async (
  client: RedisClient,
  timeoutMs = 2_000,
): Promise<void> => {
  if (client.status === 'end') {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // quit() resolves when the server has answered, a moment before the socket
  // has closed. Waiting for 'end' means the caller can exit right after.
  const ended = new Promise<void>((resolve) => {
    client.once('end', () => resolve());
  });
  try {
    await Promise.race([
      client.quit().then(() => ended),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('quit timed out')),
          timeoutMs,
        );
      }),
    ]);
  } catch {
    client.disconnect();
  } finally {
    clearTimeout(timer);
  }
};

const KEY_PART = /^[A-Za-z0-9._-]+$/;

/**
 * Builds keys of the form `hk:<service>:<part>:<part>`, so two services can
 * never collide and every key shows who owns it.
 *
 * Tenant data must carry the tenant in its key:
 *   key('rate-limit', tenantId, 'login')
 */
export const createKeyBuilder = (
  service: string,
): ((...parts: string[]) => string) => {
  if (!KEY_PART.test(service)) {
    throw new Error('Redis key service name has invalid characters.');
  }
  return (...parts) => {
    if (parts.length === 0 || parts.some((part) => !KEY_PART.test(part))) {
      throw new Error(
        'Redis key parts must be non-empty and use only letters, digits, dot, underscore and hyphen.',
      );
    }
    return `hk:${service}:${parts.join(':')}`;
  };
};
