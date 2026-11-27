# @hk/platform/outbox

Announces a state change to other services if, and only if, the change committed.

This is a money path (plan row 1.4 ⚑). The tests in `outbox.spec.ts` were written and reviewed before
the implementation and are the contract: they must not be changed to make code pass. See ADR 0005.

Changes here need Henson's line-by-line review.

## The contract

**Writing.** `outbox.append(transaction, { topic, payload })` records the event in the caller's
transaction. The transaction is a parameter, so an event cannot be appended outside one. If the
transaction rolls back, the event never existed.

**Relaying.** `relay.drain()` takes due, unpublished events in the order they were written, hands
each to `publish`, and marks the ones that succeeded.

| Situation                                     | Result                                                           |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Transaction rolled back                       | Never published.                                                 |
| Transaction still open                        | Not published yet.                                               |
| Publish fails                                 | Event stays, attempt counted, retried after a doubling back-off. |
| One event cannot be published                 | The events behind it are still published.                        |
| Process dies after publishing, before marking | Published again with the **same id**. Delivery is at least once. |
| Several relays run at once                    | Each event is published once between them.                       |

**To BullMQ.** `createQueuePublisher` publishes to the queue named after the topic, with the event
id as the job id, so a repeated publish is ignored while the first is known to the queue.

Because delivery is at least once, every consumer deduplicates on the event id with
`@hk/platform/inbox`.

The outbox table is not under the tenant row-level-security policy: the relay reads every
business's events. `tenant_id` and `business_id` are carried as data so the consumer can restore the
tenant context.

## Tests

```sh
pnpm infra:up
HK_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54320/hk \
HK_TEST_REDIS_URL=redis://127.0.0.1:63790 pnpm nx test platform-outbox
```
