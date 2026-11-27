# @hk/platform/inbox

Makes a consumer apply each event once, however many times it is delivered.

> **Status: contract and failure-path tests only.** This is a money path (plan row 1.4 ⚑), so its
> tests were written first. `createInbox()` throws until the implementation lands. The tests in
> `inbox.spec.ts` are marked `it.failing` and must not be changed to make code pass.

Changes here need Henson's line-by-line review.

## The contract

`inbox.once(transaction, { consumer, eventId }, effect)` records `(consumer, eventId)` in the
caller's transaction, then runs `effect`. The transaction is a parameter, so the inbox cannot be
used outside one.

| Situation                                     | Result                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| First delivery                                | Effect runs. `{ duplicate: false, result }`.                             |
| Later delivery of the same event              | Effect does not run. `{ duplicate: true }`.                              |
| Effect throws, or the transaction fails later | The record rolls back with it. A redelivery runs the effect again.       |
| Two deliveries at the same moment             | The second waits for the first, then sees a duplicate. Effect runs once. |
| …and the first one fails                      | The second runs the effect.                                              |
| Two consumers, same event                     | Each handles it once.                                                    |

The inbox table is not under the tenant row-level-security policy. It holds no business data, only
which event ids were seen.

## Tests

```sh
pnpm infra:up
HK_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54320/hk pnpm nx test platform-inbox
```
