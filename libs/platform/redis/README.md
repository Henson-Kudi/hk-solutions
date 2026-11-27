# @hk/platform/redis

Redis connections (ioredis) with the platform's defaults.

```ts
import { closeRedis, createKeyBuilder, createRedis, pingRedis } from '@hk/platform/redis';

const redis = createRedis({ url: config.REDIS_URL, name: 'sales-cache', logger });
const queueConnection = createRedis({
  url: config.REDIS_URL,
  name: 'sales-queue',
  purpose: 'queue', // required for BullMQ
});

const key = createKeyBuilder('sales');
await redis.set(key('rate-limit', tenantId, 'login'), '1', 'EX', 60);

await closeRedis(redis); // during shutdown
```

- The URL can hold a password and is never logged or put in an error.
- A lost connection never stops the process. The client reconnects forever with a capped back-off;
  register `pingRedis` as a readiness check so traffic stops meanwhile.
- With `purpose: 'commands'` (the default) a command fails after 3 retries when Redis is away, so a
  request gets an error instead of hanging. With `purpose: 'queue'` commands wait, as BullMQ needs.
- Keys are `hk:<service>:<part>:…`. Data that belongs to a tenant carries the tenant id in its key.

## Tests

Some tests need a server and run only when `HK_TEST_REDIS_URL` is set:

```sh
pnpm infra:up
HK_TEST_REDIS_URL=redis://127.0.0.1:63790 pnpm nx test platform-redis
```
