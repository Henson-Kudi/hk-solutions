# @hk/platform/config

Reads and validates a service's configuration once, at start-up.

```ts
import { env, loadConfig, serviceEnv } from '@hk/platform/config';
import { z } from 'zod';

export const config = loadConfig(
  z.object({
    ...serviceEnv, // NODE_ENV, LOG_LEVEL, PORT, OTEL_EXPORTER_OTLP_ENDPOINT
    DATABASE_URL: env.url(['postgres:', 'postgresql:']),
    REDIS_URL: env.url(['redis:', 'rediss:']),
    SHUTDOWN_TIMEOUT: env.duration().default(10_000),
  }),
);
```

- Call `loadConfig` in the service's main file and pass the result down. Nothing else reads
  `process.env`.
- A variable set to an empty string counts as not set.
- On failure it throws a `ConfigError` that names every bad variable. It never prints a value, so a
  secret cannot end up in a crash log.
- The result is deeply frozen.
- `env` has strict parsers for strings from the environment: `integer`, `port`, `boolean`, `url`,
  `duration` ("30s", "5m"), `list` and `text`.
