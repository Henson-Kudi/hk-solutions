# ADR 0013: The audit hash chain, and how core libs are laid out

- **Status:** Accepted
- **Date:** 2026-11-28
- **Decided by:** Henson
- **Relates to:** ADR 0001 (audit owned by core; module boundaries), ADR 0002 (Hermes target), ADR
  0004 (tenant isolation)

## Context

`core/audit` is the first core lib. The plan asks for a hash-chained audit log with write-once
storage. Being first, it also sets how a core lib is split into layers and tested.

## Decision

### Plan row 3.1 is three pull requests

The row lists `core/audit`, `core/files` and `core/comms`. They share nothing, and the audit
table is on the line-by-line review list. Each is its own PR, in that order. The row's "done
when" divides the same way: the chain verification test is audit's, the conformance suites are
comms'.

### A core lib is domain, application and infra-pg

- **domain**: pure rules. No database, no Node.
- **application**: ports, use cases, an in-memory adapter, and a conformance suite for each port.
- **infra-pg**: the Drizzle table and the PostgreSQL adapter, tested against a real database.

The `nest` layer (controllers, wiring) arrives with `apps/core` in row 3.11, when there is an app
to wire into. Both pure layers run under the Hermes target: `pnpm test:hermes` now includes
projects tagged `layer:domain` and `layer:application`.

Use cases declare whether they run offline in a constant (`AUDIT_USE_CASES`). None of audit's do.

### One chain per business

An event's hash is SHA-256 over the canonical text of its content and the hash of the event
before it. The chain is per business, because that is the unit of tenant isolation: a business
can verify its own trail without seeing another's.

Events that belong to no business, such as a login before a business is chosen, have no home in
this design. `core/identity` (row 3.2) decides where they go.

### Canonical text

A hash is taken over text, so the same event must always give the same text. Keys are sorted, and
there is no whitespace. PostgreSQL's `jsonb` reorders keys; sorting makes that harmless.

Details hold plain data only, and numbers must be whole. A fraction such as 0.1 does not survive
every store unchanged, and money is never a JS number anyway. The content carries a version
number so the hashed shape can change later without orphaning old events.

### The hash function is a parameter

Pure code cannot import Node's crypto, and the browser's SHA-256 is asynchronous. The domain takes
a `Sha256` function. The server passes `nodeSha256`. Tests of the chain logic in the pure layers
use `insecureTestHash`, a deterministic stand-in that says what it is in its name; real SHA-256 is
checked against published vectors in `infra-pg`.

### Appends are serialised per business by an advisory lock

Two transactions that read the same head would both claim the next sequence. `PgAuditStore` takes
`pg_advisory_xact_lock` keyed on the business before reading the head, so writers for one
business queue and writers for different businesses do not. The unique index on
`(business_id, sequence)` is the backstop.

This relies on READ COMMITTED: after the lock is granted, the head query sees what the previous
holder committed. Under REPEATABLE READ the second writer would read a stale head and fail on the
unique index.

### Write-once is a database grant

The app role is refused UPDATE, DELETE and TRUNCATE on `audit_events`. The statements are built
by `auditWriteOnceStatements` and go into the migration that creates the table.

There is no migration file yet. Core's libs share one schema and one migration stream, and where
that stream lives is settled with `apps/migrator` (row 3.11). Until then the table definition and
the grant statements are tested through the test schema, which builds its DDL the way migrations
are generated.

### What the chain proves, and what it does not

It shows an edit, a removal or an insertion anywhere but the end. It cannot show that the end was
cut off, or that the chain was rebuilt from some point with fresh hashes, unless the verifier is
given a head saved somewhere the database administrator cannot write. `verify` takes that head as
`expectedHead`.

Nothing saves heads yet. A scheduled job that verifies every chain and stores the heads outside
the database belongs with the worker in row 3.11.

## Consequences

- **A table owner or superuser can still rewrite history.** The grant stops the service; the
  chain exposes the rest; the saved head closes the last gap. All three are needed.
- **An audit event is permanent, including its mistakes.** A secret recorded in `details` cannot
  be removed. `record` accepts a redactor, and the canary tests of row 1.6 should be extended to
  the audit table when the first caller exists.
- **Recording holds a per-business lock until the transaction ends.** A long transaction that
  records early blocks other writers for that business. Record late.
- **`updated_at` and `version` exist on the table and never change.** They come with
  `tenantColumns`, which the tenancy schema check requires.
- **Verification reads the whole chain.** It is paged, but it is linear in the number of events.
  Checkpoints, verifying from a saved head onwards, are possible with the `after` option and are
  not built.
