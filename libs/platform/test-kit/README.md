# @hk/platform/test-kit

Test helpers that pure code may import: `domain` and `application` libs, country packs, and
anything else that also runs in the browser and on mobile. It uses no Node API and no test
framework, and its own tests run on the Hermes-compatible target.

For helpers that need Node or Docker (throwaway databases, containers, redaction canaries) see
`@hk/platform/testing`.

## Port conformance

A port is an interface the application layer defines. Each runtime implements it differently:
PostgreSQL on the server, SQLite on a device, in memory in tests. A **conformance suite** is the
list of behaviours every implementation must share, and each adapter's test file runs the same
suite:

```ts
import { scopedStoreConformance } from '@hk/platform/test-kit';

describe('SqliteNoteStore', () => {
  for (const testCase of scopedStoreConformance) {
    it(testCase.name, () => testCase.run(subject));
  }
});
```

That is how the same use case can run on the server, on a device and in a test with identical
results (CLAUDE.md: "every repository port has a conformance suite; each adapter passes it").

`scopedStoreConformance` covers the `ScopedStore` port: stamping of tenant, business, user and
version; isolation between businesses and tenants; versioned updates; deletes; and that returned
rows are copies. It currently runs against `InMemoryScopedStore` here and against
`ScopedRepository` on PostgreSQL in `@hk/platform/testing`.

**Writing a suite for your own port:** export a `ConformanceCase<Subject>[]`, where `Subject` is
whatever a test file must provide to drive an adapter. Use `expectEqual`, `expectTrue`,
`expectDomainError` and `expectRejection` from here in place of a framework's assertions, so the
suite runs under Jest, under Vitest and on Hermes. Then prove the suite has teeth: this lib's tests
run `scopedStoreConformance` against five deliberately broken adapters and check each is caught.

## In-memory fakes

- `InMemoryScopedStore<Data>`: a `ScopedStore` that keeps rows in memory. `store.for(scope)` gives
  the view of one business. Takes a `Clock`.
- `sequentialIds(seed?)`: valid UUID v7 values in a fixed, readable order (`…0001`, `…0002`).
- `FixedClock` is in `@hk/platform/universal`.
