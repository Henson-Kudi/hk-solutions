# core/audit

The audit trail: who did what to which record, and when. Every create, update, delete, approval
and login is recorded as an event that is never changed or removed.

Three libs, in the layers every core lib has:

| Lib                          | Runs on    | Holds                                                                    |
| ---------------------------- | ---------- | ------------------------------------------------------------------------ |
| `@hk/core/audit/domain`      | anywhere   | The event, its canonical text, the hash chain, `verifyChain`             |
| `@hk/core/audit/application` | anywhere   | The `AuditStore` port, `createAuditLog`, an in-memory store, conformance |
| `@hk/core/audit/infra-pg`    | the server | The `audit_events` table, `PgAuditStore`, SHA-256, the write-once SQL    |

## Recording an event

Record it **inside the transaction that makes the change**, so both are saved or neither is:

```ts
await withTenantTransaction(database, async () => {
  await invoices.issue(invoiceId);
  await auditLog.record(scope, {
    actor: { type: 'user', id: userId },
    action: 'update',
    entityType: 'sales.invoice',
    entityId: invoiceId,
    details: { field: 'status', from: 'draft', to: 'issued' },
    requestId,
  });
});
```

- `details` is plain data: strings, whole numbers, booleans, null, arrays, objects. Decimals and
  money are strings.
- **Never put a password, token, OTP, ID number or phone number in `details`.** An event cannot
  be edited or deleted afterwards. Pass the platform redactor as `redact` as a safety net.
- No audit use case runs offline. A device's work reaches the server as sync commands, and the
  server records the events when it applies them.

## How tampering shows

Each business has one chain. An event's hash covers its own content **and** the hash of the event
before it.

| Someone with database access...       | `verify` reports                           |
| ------------------------------------- | ------------------------------------------ |
| edits an event                        | `hash` at that event                       |
| edits it and recomputes its hash      | `previous_hash` at the next event          |
| removes or inserts an event           | `sequence` at the first event out of place |
| rewrites the chain from some point on | `head`, **if** a saved head is supplied    |
| cuts events off the end               | `head`, **if** a saved head is supplied    |

The last two rows matter: a chain checked only against itself cannot notice that its end was cut
off or rebuilt. Keep the head (`{ sequence, hash }` from `verify`) somewhere the database
administrator cannot write, and pass it as `expectedHead`.

```ts
const result = await auditLog.verify(scope, { expectedHead: savedHead });
if (!result.ok) {
  // result.reason, result.brokenAt
}
```

## What stops a change, and what only shows it

- The application has no update or delete: `AuditStore` only adds and reads.
- The database refuses the service's role UPDATE, DELETE and TRUNCATE on the table
  (`auditWriteOnceStatements`).
- Row-level security keeps each business to its own events.
- The table's owner and a superuser can still change rows. Nothing stops that; the chain shows
  it.

## Adding a store

Implement `AuditStore` and run `auditStoreConformance` against it. `append` must read the head and
store the event as one step: two appends at once must not be given the same head.

## Review

`infra-pg/src/lib/schema.ts` and `write-once.ts` become a migration. They need Henson's
line-by-line review.
