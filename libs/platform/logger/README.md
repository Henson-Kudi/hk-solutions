# @hk/platform/logger

The service logger: JSON lines through Pino, behind a small `Logger` interface.

```ts
import { createLogger, runWithLogContext } from '@hk/platform/logger';

const logger = createLogger({ service: 'sales', level: config.LOG_LEVEL });

logger.info('invoice issued', { invoiceId }); // constant message, values as fields
logger.error('payment call failed', { err }); // an Error under any key is serialised with its cause
```

- **The message is a constant string.** Values go in the fields object. Lint rejects a template
  literal or concatenation as the message.
- **Never log** tokens, OTPs, ID numbers, phone numbers or request bodies. As a safety net the
  values of the keys in `SENSITIVE_KEYS` (`password`, `token`, `otp`, `authorization`, …) are
  replaced with `[REDACTED]` up to three levels deep. Redaction of values by pattern arrives with
  `platform/redaction`, through the `redact` option.
- **Log context.** `runWithLogContext({ requestId }, fn)` puts those fields on every line written
  inside `fn`, across awaits. The request middleware and the queue worker set it for you.
  `addLogContext` adds fields learned later, such as the tenant.
- **In tests** use `createMemoryLogger()`. It is the real logger writing to memory, so a test can
  assert on what would be written, and that a secret is not.
