# @hk/platform/http

The client for calls from one service to another, on Node's built-in `fetch`.

```ts
import { HttpClientError, createHttpClient } from '@hk/platform/http';

const core = createHttpClient({
  baseUrl: config.CORE_URL,
  name: 'core-api',
  logger,
  headers: () => ({ ...traceHeaders(), 'x-request-id': currentRequestId() ?? '' }),
});

const { data } = await core.get<Contact>('/contacts/abc');

await core.post('/postings', {
  body: intent,
  idempotencyKey: `sales:invoice:${invoiceId}:post`,
});
```

## Retries, and why writes are special

- A request is repeated only when repeating is safe: a `GET` or `HEAD`, or any request that carries
  an `idempotencyKey`. A `POST` without a key is sent **once**.
- It is repeated after a timeout, a network error, or a 429, 502, 503 or 504, with exponential
  back-off, honouring `Retry-After`.
- Any status of 400 or above throws `HttpClientError`. When the server sent problem details they
  are on `error.problem`.

**`error.outcomeUnknown`** is true when a write may have been applied even though the call failed:
it timed out, the connection broke, or the server answered 5xx. Do not treat that as "it did not
happen". Record the operation as unknown and reconcile it, or repeat the call with the same
idempotency key. For payments this is the difference between `UNKNOWN` and `FAILED`.

The error message holds the client name, method, path and status. It never holds the query string,
headers or bodies.
