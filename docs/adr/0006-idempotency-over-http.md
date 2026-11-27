# ADR 0006: Idempotency over HTTP, route coverage and key cleanup

- **Status:** Accepted
- **Date:** 2026-11-27
- **Decided by:** Henson
- **Relates to:** ADR 0001 D22 (idempotency); ADR 0005 (idempotency, outbox and inbox)

## Context

ADR 0005 fixed how a key is claimed, completed and replayed. Three pieces remained: how an HTTP
handler opts in, how we know no write handler was forgotten, and when a stored key is deleted. Their
behaviour was fixed as 25 failure-path tests, reviewed and merged before the implementation (PR 19).

## Decision

### `@Idempotent()` and `@IdempotencyExempt(reason)`

Every POST, PUT, PATCH and DELETE handler carries exactly one of the two. `IdempotencyInterceptor`,
installed for the whole app, enforces `@Idempotent()`.

- **What "the same request" means:** the HTTP method, the route pattern, the path parameters, the
  query and the body. Headers are not part of it. Any difference under a used key is a 422.
- **The operation name is the method and the route pattern**, for example
  `POST /payments/:id/capture`. Parameter values are in the request hash, not in the operation.
- **A replay returns the same status code and body**, with `Idempotent-Replayed: true`. The status
  stored is the one Nest answers with: the handler's `@HttpCode`, otherwise 201 for POST and 200 for
  the rest.
- **The handler runs inside the transaction that records the key.** The interceptor subscribes to
  the handler from within `execute`, so the handler's writes and the key commit together, and roll
  back together when it throws. A failed request stores nothing and can be retried.
- **Reads pass through.** GET, HEAD and OPTIONS handlers are untouched.

### Fail closed

A write handler that declares nothing, declares both, or gives an empty exemption reason is answered
500 and does not run. The log carries the code `IDEMPOTENCY_NOT_DECLARED`.

This is the backstop. The first line of defence is `findUncoveredRoutes(controllers)`, which lists
such handlers. Each service has a test that asserts the list is empty for all its controllers, so
the mistake fails CI before it can reach a running service.

### Cleanup

`createIdempotencyCleanup().purge()` deletes keys whose `expires_at` has passed, oldest first, one
batch per call, with `FOR UPDATE SKIP LOCKED` so two runs do not wait on each other.

- **A key that is in flight with a live lease is never deleted**, whatever its `expires_at`.
  Deleting it would let a second request run beside the first.
- **A purged key counts as never used.** The promise to replay lasts for the retention period (24
  hours by default) and no longer.

## Consequences

- **A handler's whole body runs in one database transaction.** That is the point, but it means an
  `@Idempotent()` handler must stay short and must not call a remote service. A use case that needs
  a provider call records an intent in the handler and makes the call outside it.
- **The response body is what the handler returned, after a round trip through JSON.** A first
  response and its replay are therefore byte-for-byte the same, and a handler cannot rely on
  returning something JSON cannot carry.
- **Response headers set by a handler are not stored.** A replay carries the stored status and body
  only. A handler that must return a `Location` header needs that added to the contract first.
- **Retention bounds the guarantee.** A client that retries a write more than 24 hours later, after
  cleanup has run, executes it again. Offline devices that sync late are the case to watch: their
  commands carry their own ids, and the use cases they reach must tolerate that, or retention must
  be longer for the sync endpoint.
- **The interceptor reads Express request fields** (`route.path`, `baseUrl`, `params`, `query`,
  `body`), like the request middleware in `platform/nest`.
- **Not done yet:** the scheduled job that calls `purge()`, which belongs to the app that owns each
  schema, and carrying trace headers into outbox events.
