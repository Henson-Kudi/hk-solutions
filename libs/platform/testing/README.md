# @hk/platform/testing

Helpers for integration tests that need Node or Docker. For test code only: never import it from a
lib's source.

Helpers that pure code may import (in-memory fakes, the port conformance harness) are in
`@hk/platform/test-kit`.

## Servers to test against

A suite that needs PostgreSQL or Redis takes it from the environment, and skips those tests when
there is none:

```ts
const adminUrl = postgresTestUrl(); // HK_TEST_DATABASE_URL, a superuser URL
const describeWithPostgres = adminUrl ? describe : describe.skip;
```

```sh
pnpm infra:up
HK_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54320/hk \
HK_TEST_REDIS_URL=redis://127.0.0.1:63790 pnpm nx affected -t test
```

CI always sets both, and each suite has a guard test that fails in CI if a URL is missing, so the
tests cannot be skipped there by accident.

**Testcontainers.** `startPostgresContainer()` and `startRedisContainer()` start a throwaway
server in Docker and return `{ url, stop }`. `acquirePostgres()` and `acquireRedis()` return the
configured server when there is one, start a container when `HK_TEST_CONTAINERS=1`, and otherwise
return undefined. Starting a container per test file is slower than one shared server, so the
shared server stays the default.

## `createTestSchema`

Creates a throwaway PostgreSQL schema laid out like a real service's, and removes it afterwards:

```ts
const schema = await createTestSchema({
  adminUrl,
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

## Redaction canaries

A canary is a made-up secret with a value nothing else contains. Push the canaries through any
place where data leaves a service, then search the output:

```ts
logger.info('something happened', canaryFields());
expect(findLeaks(memory.text())).toEqual([]);
```

- `canaryFields()`: the canaries as log fields, under telling keys, nested, in free text and
  inside an Error.
- `canaryText()`: the ones recognisable only by their shape, in one sentence.
- `canaryDetails()`: a flat object of strings, the shape of `DomainError` details.
- `findLeaks(output)`: the names of the canaries found.

`canary.spec.ts` here is **the canary test**. It covers the logger, error responses and the HTTP
client, and its last block switches redaction off and checks that the canaries are then found, so
the test is known to be able to fail. Add a block when you add a new sink.

## Also here

- `deferred()`: a promise with its `resolve` and `reject` exposed, to hold a handler open.
- `waitFor(condition)`: polls until true, or throws after a timeout.
- `scoped-repository.conformance.spec.ts`: runs the `ScopedStore` conformance suite from
  `@hk/platform/test-kit` against `ScopedRepository` on PostgreSQL. Copy it for a new repository.
