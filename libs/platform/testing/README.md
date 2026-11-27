# @hk/platform/testing

Helpers for integration tests. For test code only: never import it from a lib's source.

This is a first seed. Plan row 1.6 adds Testcontainers, in-memory port fakes and the port
conformance harness.

## `createTestSchema`

Creates a throwaway PostgreSQL schema laid out like a real service's, and removes it afterwards:

```ts
const schema = await createTestSchema({
  adminUrl: postgresTestUrl() as string,
  prefix: 'outbox',
  define: (target) => ({ outbox: outboxTable(target) }),
});
const database = createDatabase({ url: schema.appUrl, name: 'spec' });
// …
await schema.truncate('outbox'); // between tests
await database.close();
await schema.drop();
```

- Tables are owned by a role that cannot log in. Code under test connects with `appUrl`, as a role
  that owns nothing and is not a superuser, so row-level security applies to it.
- Tables are created by drizzle-kit from the Drizzle definitions, the way real migrations are
  generated.
- `schema.admin` is a superuser connection for arranging and inspecting state behind the code's
  back.
- Names are unique per call, so suites can run in parallel on one server.

## Also here

- `postgresTestUrl()`, `redisTestUrl()`: the URLs from `HK_TEST_DATABASE_URL` and
  `HK_TEST_REDIS_URL`, or undefined. Suites skip their server-dependent tests when undefined, and a
  guard test fails in CI if they are.
- `deferred()`: a promise with its `resolve` and `reject` exposed, to hold a handler open.
- `waitFor(condition)`: polls until true, or throws after a timeout.
