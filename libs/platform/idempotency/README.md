# @hk/platform/idempotency

Makes a write happen at most once per `Idempotency-Key`.

This is a money path (plan row 1.4 ⚑). The tests in `idempotency.spec.ts` were written and reviewed before
the implementation and are the contract: they must not be changed to make code pass. See ADR 0005.

Changes here need Henson's line-by-line review.

## The contract

`idempotency.execute({ key, operation, request }, handler)`:

| Situation                                        | Result                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| No key                                           | 400 `IDEMPOTENCY_KEY_MISSING`. Handler does not run.                         |
| Key empty, over 255 characters, or not ASCII     | 400 `IDEMPOTENCY_KEY_INVALID`.                                               |
| First use                                        | Handler runs once. Its response is stored.                                   |
| Same key, same request, completed                | Stored response, `replayed: true`. Handler does not run.                     |
| Same key, first request still running            | 409 `IDEMPOTENCY_IN_FLIGHT`.                                                 |
| Same key, different operation or request         | 422 `IDEMPOTENCY_KEY_REUSED`, also while the first is in flight.             |
| Handler throws                                   | Its transaction rolls back, nothing is stored, the key can retry.            |
| Process dies after commit, before answering      | The retry gets the committed response. Handler does not run again.           |
| Attempt outlives its lease and another took over | The old attempt fails with 409 `IDEMPOTENCY_LEASE_LOST` and commits nothing. |

Three points behind that table:

- **The response is stored in the same transaction as the business change.** That is what makes
  "committed but no answer" recoverable without a second execution.
- **Keys are scoped** to the tenant and business of the request, or to "public" before sign-in.
- **Only a hash of the request is stored**, never the request.

## Tests

```sh
pnpm infra:up
HK_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54320/hk pnpm nx test platform-idempotency
```
