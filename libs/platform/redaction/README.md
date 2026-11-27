# @hk/platform/redaction

Keeps secrets and personal data out of logs and error responses.

It is a safety net, not permission to log carelessly. The rule in `CLAUDE.md` stands: do not log
tokens, OTPs, ID numbers, phone numbers or request bodies in the first place.

## Where it is applied

You rarely call it yourself. It is already wired into:

| Place                 | What is redacted                                              |
| --------------------- | ------------------------------------------------------------- |
| `@hk/platform/logger` | The fields of every line, child fields and the log context.   |
| `@hk/platform/errors` | `detail`, `details` and field messages of a problem response. |
| `@hk/platform/http`   | The problem details attached to an `HttpClientError`.         |

## How it decides

A value is replaced with `[REDACTED]` when either applies:

**By key.** The value sits under a key that, in lower case with punctuation removed, equals or ends
with a sensitive name: `password`, `token`, `apiKey`, `authorization`, `cookie`, `otp`, `pin`,
`phone`, `msisdn`, `mobile`, `idNumber`, `nationalId`, `passportNumber`, `cardNumber`, `iban`,
`body`, and more (`SENSITIVE_KEYS`). So `access_token`, `X-Api-Key` and `customerPhone` match,
and `tokenCount` and `passwordless` do not.

**By shape.** Any string is searched for:

| Shape                      | Example                             | Becomes                             |
| -------------------------- | ----------------------------------- | ----------------------------------- |
| JWT                        | `eyJhbGciOi….eyJzdWIi….c2lnbmF0…`   | `[REDACTED]`                        |
| Bearer or Basic credential | `Bearer abc123def456`               | `Bearer [REDACTED]`                 |
| Password in a URL          | `postgres://sales:hunter2@db/hk`    | `postgres://sales:[REDACTED]@db/hk` |
| International phone number | `+237 6 77 12 34 56`                | `[REDACTED]`                        |
| Payment card number        | `4111 1111 1111 1111` (passes Luhn) | `[REDACTED]`                        |

Amounts, quantities, UUIDs, timestamps, dates and document numbers pass through untouched.

## What it cannot do

- **A local phone number in free text** (`677123456`) looks like any other number. It is only
  caught under a key such as `phone`.
- **National ID numbers** have country-specific formats. Add them as patterns:

  ```ts
  const redactor = createRedactor({
    patterns: [{ name: 'emirates-id', pattern: /\b784-\d{4}-\d{7}-\d\b/g }],
  });
  const logger = createLogger({ service: 'core', redact: redactor.redact });
  ```

- **Anything it has no rule for.** Use the canaries in `@hk/platform/testing` to test a new sink.

## Use

```ts
import { createRedactor, defaultRedactor } from '@hk/platform/redaction';

defaultRedactor.redact({ user: { password: 'x' }, note: 'call +237677123456' });
// { user: { password: '[REDACTED]' }, note: 'call [REDACTED]' }

defaultRedactor.redactText('failed for postgres://app:secret@db/hk');
```

`redact` returns a copy and never changes its input. It handles nested objects, arrays, Errors
(message, stack, cause and own fields), class instances with `toJSON`, circular references and a
depth limit.
