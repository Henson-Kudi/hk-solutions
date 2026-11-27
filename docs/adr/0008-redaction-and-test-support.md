# ADR 0008: Redaction, and how test support is split

- **Status:** Accepted
- **Date:** 2026-11-27
- **Decided by:** Henson
- **Relates to:** ADR 0001 D7 (shared logic), D28 (boundaries); ADR 0002 (Hermes target); ADR 0003
  (platform kernel)
- **Supersedes:** the consequences "No value-pattern redaction yet" and "An error's original
  message is in the logs even when hidden from the caller" of ADR 0003

## Context

Two things remained from the platform kernel:

- ADR 0003 left the logger redacting by key name only. A secret inside free text, such as a
  password in a connection string quoted by an error message, still reached the logs.
- The plan puts Testcontainers, in-memory port fakes and a port conformance harness in one lib,
  `platform/testing`.

## Decision

### Redaction

`libs/platform/redaction` replaces a value when either of two tests applies.

- **By key.** The key, in lower case with punctuation removed, equals or ends with a name in
  `SENSITIVE_KEYS`. Ending is enough, so `access_token` and `customerPhone` match; a prefix is not,
  so `tokenCount` does not.
- **By shape.** Every string is searched for a JWT, a Bearer or Basic credential, a password in a
  URL, an international phone number, and a payment card number that passes the Luhn check.

It is applied in three places, and on by default in each:

| Place             | What                                                          |
| ----------------- | ------------------------------------------------------------- |
| `platform/logger` | The fields of every line, child fields, the log context.      |
| `platform/errors` | `detail`, `details` and field messages of a problem response. |
| `platform/http`   | The remote problem details kept on an `HttpClientError`.      |

The logger's own list of redacted key paths stays as a second layer.

**The shapes are deliberately narrow.** Each must not swallow ordinary business data. Amounts,
quantities, UUIDs, timestamps, dates and document numbers pass through, and tests pin that. A card
number needs 14 to 19 digits and a valid Luhn check: 13 digits is left out because a millisecond
timestamp has 13, and one in ten would pass.

**Country-specific formats are not built in.** A national ID format is country data, which belongs
to a country pack. `createRedactor({ patterns })` accepts them.

### The canary test

`platform/testing` exports canaries: fake secrets with unique values, a way to plant them, and
`findLeaks` to search output for them. `canary.spec.ts` pushes them through the logger, error
responses and the HTTP client and requires that none comes out. Its last block switches redaction
off and requires that they are then found, so the test is known to be able to fail.

A new place where data leaves a service gets a block in that test.

### Test support is two libs

| Lib                 | Runs on                    | Holds                                                           |
| ------------------- | -------------------------- | --------------------------------------------------------------- |
| `platform/testing`  | Node, with Docker for some | Testcontainers, `createTestSchema`, redaction canaries.         |
| `platform/test-kit` | Everywhere (universal)     | In-memory fakes, the port conformance harness, `sequentialIds`. |

The plan has one lib. It is split because `domain` and `application` libs may only import
universal code (ADR 0001 D28), and those are the libs whose tests need the fakes and the harness.
`platform/test-kit` is tagged `runtime:universal`, uses no Node API and no test framework, and its
own tests run on the Hermes target.

### Port conformance

A conformance suite is a list of `{ name, run(subject) }` cases. An adapter's test file loops over
it and passes a `subject` that knows how to drive that adapter. Cases use the small assertions in
`platform/test-kit`, not a test framework's, so one suite runs under Jest, Vitest and Hermes.

The first suite, `scopedStoreConformance`, defines the `ScopedStore` port: what
`platform/db`'s `ScopedRepository` offers on PostgreSQL. It runs against the in-memory store and
against PostgreSQL. A suite must be shown to have teeth: this one is run against five deliberately
broken adapters, and each is caught.

### Containers are a fallback, not the default

Suites keep reading `HK_TEST_DATABASE_URL` and `HK_TEST_REDIS_URL`. `acquirePostgres()` and
`acquireRedis()` use the configured server, and start a container only when none is configured and
`HK_TEST_CONTAINERS=1`. One shared server is faster than a container per test file. CI sets all
three variables, so the container helpers themselves are tested there.

## Consequences

- **Redaction costs a walk over the fields of every log line.** It is a copy with a depth limit of 8. If logging ever shows up in a profile, this is where to look.
- **Redaction can hide something you wanted to see.** A value under a key such as `body` or
  `mobile` is replaced whatever it holds. Rename the field, do not weaken the list.
- **A local phone number in free text is not caught.** Nine digits look like any other number. It
  is caught under a key. The rule not to log phone numbers still carries the weight here.
- **National ID numbers are not caught by shape** until a country pack supplies its patterns.
- **A crash message is now redacted in the logs**, including a connection string's password. Its
  host and user remain, which is what makes the line useful.
- **Existing suites were not moved to `acquirePostgres()`.** They still skip without a URL. Moving
  them is mechanical and can follow.
- **Three more install scripts are switched off** (`ssh2`, `cpu-features`, `protobufjs`, all from
  Testcontainers). Each has a pure JavaScript fallback.
- **`ScopedStore` is defined in `platform/test-kit`, and `ScopedRepository` satisfies it without
  importing it.** When the first product defines its repository ports, they follow this shape, and
  the interface may move next to them.
