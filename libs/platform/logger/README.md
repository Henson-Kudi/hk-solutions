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
- **Never log** tokens, OTPs, ID numbers, phone numbers or request bodies. As a safety net every
  line goes through `@hk/platform/redaction`, which replaces values by key (`password`, `otp`,
  `phone`, …) and by shape (a token, a password in a URL, an international phone number, a card
  number) wherever they appear, including inside an error message. Pass
  `redact: createRedactor({ keys, patterns }).redact` to add your own, such as a national ID format.
- **Log context.** `runWithLogContext({ requestId }, fn)` puts those fields on every line written
  inside `fn`, across awaits. The request middleware and the queue worker set it for you.
  `addLogContext` adds fields learned later, such as the tenant.
- **In tests** use `createMemoryLogger()`. It is the real logger writing to memory, so a test can
  assert on what would be written, and that a secret is not.
