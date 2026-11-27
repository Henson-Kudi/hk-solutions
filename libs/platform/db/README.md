# @hk/platform/db

How a service talks to PostgreSQL, and how one business is kept from seeing another's data.

Changes here need Henson's line-by-line review.

## Two layers of isolation

1. **`ScopedRepository`** filters every query by the tenant and business of the current
   `TenantContext`, and stamps them on every insert.
2. **Row-level security** in the database refuses to show or accept a row of another business,
   whatever the SQL says. This holds for raw queries and for code that forgets layer 1.

Each layer is tested with the other one out of the way.

## Using it

**Define a table.** Start with `tenantColumns` and add `tenantIsolation`:

```ts
export const sales = pgSchema('sales');

export const invoices = sales.table('invoices', { ...tenantColumns, ...branchColumn, number: text('number').notNull() }, (table) => [...tenantIsolation('invoices', table)]);
```

`tenantIsolation` adds the `(tenant_id, business_id)` index and the `tenant_isolation` policy.
drizzle-kit turns that into `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` in the migration.

**Write a repository.** Extend `ScopedRepository` and expose methods in the aggregate's language:

```ts
export class PgInvoiceRepository extends ScopedRepository<typeof invoices> implements InvoiceRepository {
  constructor() {
    super(invoices);
  }
  byId(id: string) {
    return this.findById(id);
  }
  byNumber(number: string) {
    return this.find(eq(invoices.number, number), { limit: 1 });
  }
}
```

For a query the building blocks do not cover, use `this.transaction` and put `this.scope(...)` in the
`WHERE` clause.

**Run a use case.** Set the context at the edge, then open a transaction:

```ts
await runWithTenantContext({ tenantId, businessId, userId }, () =>
  withTenantTransaction(database, async () => {
    const invoice = await invoices.byId(id);
    // … change it, write the outbox row: one transaction
  }),
);
```

## Rules

- **Tenant data is only reachable inside `withTenantTransaction`.** It sets `app.tenant_id` and
  `app.business_id` for the transaction only (the effect of `SET LOCAL`), which is what the policy
  reads. A repository call outside one throws. A raw query outside one sees no rows.
- **No tenant context, no query.** `ScopedRepository` and `withTenantTransaction` throw
  `TENANT_CONTEXT_MISSING`.
- **A context cannot be switched from inside.** Work for another business starts from the edge
  again: a new request or a new job. Re-entering for the same business is allowed.
- **`withSystemTransaction`** is for work that is not about one business: login lookups, the outbox
  relay, reference tables. Protected tables show nothing in it, and a `ScopedRepository` refuses to
  run in it.
- **Nested calls join** the open transaction, so everything commits or rolls back together.
- **Never call a remote service inside a transaction.** It holds a connection and locks.
- **Updates are versioned.** `update(id, expectedVersion, patch)` throws `ROW_STALE_VERSION` when
  someone else changed the row first.
- **Services connect as their app role** (`hk_<service>_app`). Row-level security does not apply to
  a superuser or to a table's owner, so connecting as either would switch layer 2 off.

## Checking a service's schema

Every service has a test like this, so a table added without the tenant columns, index or policy
fails CI:

```ts
import * as schema from './schema';

expect(findTenantSchemaViolations(tablesOf(schema), { exempt: ['core.countries'] })).toEqual([]);
```

`findTenantCatalogViolations(transaction, 'sales')` asks the database the same question after
migrations have run. It catches a migration that was never applied and a policy dropped by hand.

## Building a lib that exports Drizzle tables

Its `tsconfig.lib.json` needs `"module": "nodenext"` and `"moduleResolution": "nodenext"`. With the
generator's default (`commonjs` with `bundler` resolution) TypeScript cannot write declaration files
for exported tables (error TS2883). See ADR 0004.

## Tests

The isolation tests need a real PostgreSQL and a superuser URL, because they create roles:

```sh
pnpm infra:up
HK_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54320/hk pnpm nx test platform-db
```

They create a throwaway schema with an owner role and an app role, and remove them afterwards.
