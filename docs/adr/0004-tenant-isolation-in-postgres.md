# ADR 0004: How tenant isolation is enforced in PostgreSQL

- **Status:** Accepted
- **Date:** 2026-11-27
- **Decided by:** Henson
- **Relates to:** ADR 0001 D12 (database), D13 (row scoping), D14 (ORM), D15 (migrations)

## Context

ADR 0001 D13 says every business table carries `tenant_id` and `business_id`, is accessed through
scoped repositories, and is protected by PostgreSQL row-level security (RLS) as a second layer.
`libs/platform/db` implements that. This record fixes the details that the code now depends on.

## Decision

### The tenant reaches the database through transaction-local settings

`withTenantTransaction` opens a transaction and first runs
`select set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`.

- `set_config(…, true)` has the effect of `SET LOCAL`: the value lasts until the transaction ends.
  It is used instead of the `SET LOCAL` statement because it takes bind parameters.
- The values come from `TenantContext`, an `AsyncLocalStorage` set once at the edge of a unit of
  work. Its ids must be canonical UUIDs.
- Because the settings are local to the transaction, a pooled connection never carries one tenant
  over to the next user.

**Consequence: tenant data is only reachable inside `withTenantTransaction`,** reads included.

### One policy, on every business table

```sql
tenant_id   = nullif(current_setting('app.tenant_id',   true), '')::uuid
and
business_id = nullif(current_setting('app.business_id', true), '')::uuid
```

It is the `USING` and the `WITH CHECK` clause of a policy named `tenant_isolation`, for all commands
and all roles. With no tenant set, the comparison is NULL and no row matches: the default is
"see nothing", not an error and not "see everything".

Both columns are checked, although `business_id` alone would identify the row, so that a wrong
pairing of tenant and business also matches nothing.

`tenantIsolation()` declares the policy and the `(tenant_id, business_id)` index in the Drizzle
table definition, and drizzle-kit writes the `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY`
statements into the migration.

### RLS is not forced on the table owner

PostgreSQL does not apply RLS to superusers or to a table's owner, unless the table has
`FORCE ROW LEVEL SECURITY`. We do not force it.

- Services log in as `hk_<service>_app`, which owns nothing and is not a superuser, so RLS applies
  to everything a service does.
- Tables are owned by `hk_<service>_owner`, which cannot log in. Only the migrator assumes it, and
  migrations sometimes need to touch rows of every business (a backfill).

**Consequence:** a service that connected as the owner or as a superuser would have layer 2
switched off without any error. The integration tests assert that the connection under test is
neither, and the same check belongs in each service's start-up when services exist.

### A tenant context cannot be switched from inside

Starting a context for a different tenant or business while one is active throws. Work for another
business starts from the edge again: a new request or a new job. Re-entering for the same business
is allowed, to add the user or the branch.

Reads across several businesses (consolidation, the account switcher) are not covered here. They
get their own reader and their own policy when they are built, as a new ADR.

### System transactions

`withSystemTransaction` runs without tenant settings, for work that is not about one business:
looking up a user at login, relaying outbox rows, reference tables. Protected tables show no rows
in it and accept none. A `ScopedRepository` refuses to run in it, and the two kinds of transaction
cannot be nested in each other.

### Schema checks

- `findTenantSchemaViolations` checks Drizzle definitions: the tenant columns, the index, the
  policy with both clauses. Each service runs it over all its tables in a unit test.
- `findTenantCatalogViolations` asks the database the same question after migrations.
- Tables that are deliberately not tenant-scoped go in an explicit `exempt` list.

### Build setting for libs that export Drizzle tables

Their `tsconfig.lib.json` sets `"module": "nodenext"` and `"moduleResolution": "nodenext"`. The
generator's default pairs `module: commonjs` with `moduleResolution: bundler`. Under that pairing
TypeScript resolves Drizzle's CommonJS entry for imports but cannot name its types when writing
declaration files, and the build fails with TS2883 on every exported table. The output stays
CommonJS.

### Tests that need PostgreSQL

The isolation tests run against a real server when `HK_TEST_DATABASE_URL` is set, and are skipped
otherwise. CI provides a PostgreSQL 17 service container, and a guard test fails in CI if the
variable is missing. The suite creates a throwaway schema with an owner role and an app role,
generates the tables with drizzle-kit from the Drizzle definitions, and connects as the app role.
`platform/testing` (Testcontainers) replaces this arrangement when it lands.

## Consequences

- **Every read of tenant data costs a transaction and one extra statement.** That is the price of
  transaction-local settings. It is also what makes the pooled connection safe.
- **Isolation does not depend on every query being written correctly.** A raw query, a forgotten
  `scope()`, or a bug in a repository still cannot cross businesses. A control run with the policy
  replaced by `true` makes the eight raw-query tests fail while the repository tests keep passing,
  which shows the two layers are independent.
- **The owner role is the weak point.** Anything that runs as owner or superuser bypasses RLS. That
  is limited to the migrator by the role layout in `deploy/sql/bootstrap.sql`, which is still to be
  written.
- **Platform tables that are not per-business** (outbox, inbox, idempotency keys) need a decision
  each: tenant policy, or an entry in the exempt list with a reason. That is part of the rows that
  add them.
- **Other libs still use the generator's module settings.** They build because none of them exports
  a type inferred from a dual-format package. The product generator must set `nodenext` for
  `infra-pg` libs.
