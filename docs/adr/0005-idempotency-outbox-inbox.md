# ADR 0005: Idempotency, outbox and inbox

- **Status:** Accepted
- **Date:** 2026-11-27
- **Decided by:** Henson
- **Relates to:** ADR 0001 D9 (events), D17 (ledger), D22 (idempotency); ADR 0004 (tenant isolation)

## Context

Three guarantees hold the money paths together:

- a write requested twice happens once (idempotency);
- a state change is announced to other services if and only if it committed (outbox);
- an announcement delivered twice is applied once (inbox).

The plan names the failure scenarios but not the behaviour behind them. That behaviour was fixed as
54 failure-path tests, reviewed and merged before any implementation (PR 17). This record states
the decisions those tests encode and the implementation choices made to satisfy them.

## Decision

### Idempotency

**The response is stored in the same transaction as the business change.** `execute` works in two
steps:

1. **Claim** the key, in a statement of its own that commits at once, so other requests can see the
   key is taken while the handler runs. The row is `IN_PROGRESS` with a lease token and a lease
   expiry.
2. **Run the handler and complete the key in one transaction.** The last statement of that
   transaction sets the row to `COMPLETED` with the response, and only matches while the row still
   carries this attempt's lease token.

What follows from that:

| Event                                          | Outcome                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Handler throws                                 | Everything rolls back. The claim is deleted, so the key can be retried at once.                |
| Process dies before commit                     | Nothing committed. The claim stays until its lease expires, then a retry takes it over.        |
| Process dies after commit, before answering    | The key is `COMPLETED` with its response. A retry is answered from the store.                  |
| Attempt outlives its lease, a retry takes over | The old attempt's completing update matches no row. It fails with `LEASE_LOST` and rolls back. |

- **Same request** means the same SHA-256 over the operation and the request in canonical JSON
  (object keys sorted). Only the hash is stored.
- **A different request under a used key is a 422**, checked before "in flight", so it is a 422
  even while the first request is still running.
- **Scope.** A key belongs to the tenant and business of the request, or to `public` before
  sign-in.
- **Key format:** 1 to 255 printable ASCII characters, no spaces.
- **An expired claim can be taken over by a different request too.** The attempt that held it is
  presumed dead and committed nothing, which is the same situation as a rolled-back attempt.
- **The alternative not taken:** store the response after commit and rebuild it from the resource
  when a retry finds a committed key without one. That needs a rebuild function per endpoint and
  leaves a window the single transaction does not have.

### Outbox

- `append(transaction, event)` takes the transaction as a parameter, so an event cannot be recorded
  outside one. The event id is a UUID v7.
- **Delivery is at least once.** The relay publishes, then marks. If it stops in between, the event
  is published again with the same id.
- **The relay publishes inside a transaction.** One pass selects due rows
  `FOR UPDATE SKIP LOCKED`, publishes each, and updates them, in one transaction. The row lock is
  what lets several relays run without publishing the same event twice, and it must be held until
  the row is marked. This is a deliberate exception to "no remote call in a transaction": the call
  is one queue insert per event and the batch is bounded (100 by default).
- **A failed publish** leaves the event pending, counts the attempt, and moves `next_attempt_at`
  out by a delay that doubles each time up to a cap. The events behind it are still published.
- **Order** is `occurred_at`, then id. It is the order events were appended, not a guarantee across
  concurrent transactions that commit out of order.
- **To BullMQ:** the queue is named after the topic, and the job id is the event id, so a repeated
  publish is ignored while the first job is still known to the queue.
- The relay opens its transaction on the Drizzle handle directly, not through
  `withSystemTransaction`, so `publish` does not run inside the relay's transaction context.

### Inbox

- `once(transaction, { consumer, eventId }, effect)` inserts `(consumer, event_id)` with
  `ON CONFLICT DO NOTHING` and runs the effect only if a row was inserted.
- The primary key does the concurrency work. A simultaneous second delivery blocks on the first's
  uncommitted row: if the first commits, the second sees a duplicate; if it rolls back, the second
  inserts and runs the effect.
- The record and the effect are in the caller's transaction, so they commit or roll back together.

### The three tables are not under the tenant policy

`idempotency_keys`, `outbox` and `inbox` are exempt from the `tenant_isolation` policy of ADR 0004.

- The relay reads the events of every business in one pass.
- A key has to be found before a tenant transaction can start, and public requests have no tenant.
- The inbox holds only event ids.

Each service lists them in the `exempt` option of its schema checks, with this reason.
`tenant_id` and `business_id` on the outbox are plain data, carried so the consumer can restore the
tenant context.

## Consequences

- **A handler must finish within the lease** (60 seconds by default). One that does not is failed
  with `LEASE_LOST` if a retry arrived meanwhile, and its work is rolled back. A handler must
  therefore not call a payment provider: provider calls record an intent first and happen outside
  the transaction, as `CLAUDE.md` already requires.
- **A response body is stored as JSON** and returned as stored. Handlers return plain data, with
  money as decimal strings. Large bodies cost storage for the retention period (24 hours by
  default).
- **Expired keys are not yet deleted.** `expires_at` is set and indexed; the cleanup job is still to
  be written.
- **Consumers must use the inbox.** At-least-once delivery means duplicates are normal, not rare.
- **The queue-level dedupe is a convenience, not the guarantee.** BullMQ forgets a completed job
  after its retention (one hour by default), so a very late republish creates a new job. The inbox
  is what makes the effect happen once.
- **A relay pass holds one connection and its row locks while it publishes.** If Redis is slow,
  that connection is held for up to a batch of enqueue timeouts. The batch size is the knob.
- **Not built yet:** the `@Idempotent()` and `@IdempotencyExempt()` decorators and the
  route-coverage test, the wiring of trace headers into outbox events, and the cleanup job.
