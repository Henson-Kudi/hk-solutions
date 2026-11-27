# ADR 0003: Platform kernel libraries, and what NestJS 12 being ESM-only means

- **Status:** Partly superseded by 0008 (redaction)
- **Date:** 2026-11-27
- **Decided by:** Henson
- **Relates to:** ADR 0001 D6 (topology), D9 (events), D23 and D25 (NestJS 12), D24 (tooling)

## Context

Every service needs the same plumbing: configuration, logging, error responses, tracing and metrics,
Redis, queues, an outbound HTTP client and shared NestJS pieces. The plan names these eight libs
under `libs/platform` without prescribing what they are built on. This record fixes those choices
so the next service does not reopen them.

Building the NestJS lib also surfaced a fact that affects the whole workspace: **NestJS 12 is
published as ES modules only.** This workspace compiles libs to CommonJS and tests them with Jest in
CommonJS mode, and Jest cannot load an ESM-only package that way.

## Decision

### Libraries

| Lib             | Built on                                                      | Rule it enforces                                                                                                                                                            |
| --------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`        | Zod                                                           | Environment is read and validated once at start-up. An error names the bad variables and never prints a value. Nothing else reads `process.env`.                            |
| `logger`        | Pino, behind our own `Logger` interface                       | A message is a constant string and values are structured fields. Sensitive keys are redacted. An async log context puts the request or job id on every line.                |
| `errors`        | RFC 9457 problem details                                      | One error body for every service. A status of 500 or above never exposes the original message, code or details.                                                             |
| `observability` | OpenTelemetry tracing, `prom-client`, our own health registry | Tracing is off unless an OTLP endpoint is configured. Metrics live in a per-service registry, never a global one. Health reports say ok, failed or timeout, and no more.    |
| `redis`         | ioredis                                                       | The URL is never logged. A lost connection never stops the process. Keys are namespaced `hk:<service>:…`.                                                                   |
| `queue`         | BullMQ (ADR 0001 D9)                                          | 5 attempts with exponential back-off by default. A job id makes an enqueue idempotent. Job data is never logged. Handlers must be idempotent.                               |
| `http`          | Node's built-in `fetch`                                       | A write is retried only when it carries an idempotency key. A write that times out or gets a 5xx is reported as `outcomeUnknown`, never as "did not happen".                |
| `nest`          | NestJS 12 on the Express adapter                              | Request id and log context, one access-log line per request, problem-details responses, Zod validation, `/health/live`, `/health/ready`, `/metrics`. No `@Global()` module. |

Alternatives considered and not taken:

- **`@nestjs/config` and `@nestjs/terminus`.** Both work, but they put configuration and health
  checks inside Nest. Ours are framework-free, so a queue worker or a script uses the same code.
- **Winston** for logging. Pino is faster and writes JSON lines by default.
- **axios** for outbound HTTP. Node's `fetch` now covers it without a dependency.
- **The Fastify adapter.** It is faster, but Express is Nest's default and has the wider middleware
  ecosystem. `request-context.ts` and `setup-http-app.ts` are the only Express-specific files, so
  this can be revisited.
- **`@opentelemetry/sdk-node` with auto-instrumentations.** It pulls in a large tree. We depend on
  the tracing packages only, and a service adds instrumentations when it has something to instrument.

### Request context and access log are middleware, not interceptors

The plan lists "filters, interceptors, decorators". Two of the pieces are middleware instead:

- The request id must be in an async context that wraps the whole request, including guards, pipes
  and exception filters. An interceptor wraps only the handler call.
- The access log must record the final status code, which is known only after exception filters
  have run.

### NestJS 12 is ESM-only

- Libs keep compiling to CommonJS. The project has no reason yet to convert everything to ESM.
- A project whose tests import NestJS runs Jest with `NODE_OPTIONS=--experimental-vm-modules`. This
  is what Nx's own Nest generator sets up, and it is set on the `test` target in the lib's
  `project.json`.
- At runtime a CommonJS service loads NestJS through Node's `require()` of ES modules, which is
  stable in Node 24.

### Tests that need Redis

`platform/redis` and `platform/queue` have tests that run against a real server when
`HK_TEST_REDIS_URL` is set, and are skipped when it is not. A wrapper around BullMQ tested against a
fake proves very little. CI provides a Redis service container, and a guard test fails in CI if the
variable is missing, so the tests cannot be skipped there by accident. Locally:

```sh
pnpm infra:up
HK_TEST_REDIS_URL=redis://127.0.0.1:63790 pnpm nx run-many -t test -p platform-redis platform-queue
```

`platform/testing` (Testcontainers) replaces this arrangement when it lands.

## Consequences

- **The Jest flag is marked experimental by Node.** Every NestJS test run prints an
  `ExperimentalWarning`, and NestJS suites start slowly (about 50 seconds for `platform/nest`
  locally) because Jest loads the framework's ES modules through that path. If this becomes a drag,
  the options are Vitest for NestJS projects, or NestJS 11, which is CommonJS. Either would be a new
  ADR.
- **No value-pattern redaction yet.** The logger redacts by key name (`password`, `token`, `otp`,
  …). A phone number or an ID number inside a free-text field is not caught until
  `platform/redaction` plugs into the logger's `redact` hook. Until then the rule in `CLAUDE.md`
  stands on review alone: never log those values.
- **An error's original message is in the logs even when hidden from the caller.** A crash message
  can contain a connection string. That is also `platform/redaction`'s job.
- **Health and metrics endpoints are unauthenticated.** They return no error text and no secrets,
  but they must not be routed by the gateway.
- **`msgpackr-extract`, a native add-on BullMQ can use, is not built** (`allowBuilds: false`).
  BullMQ falls back to pure JavaScript. This keeps install scripts off the machine at a small cost
  in serialisation speed.
- **Trace context is not yet attached to jobs or outbound calls automatically.** `traceHeaders()`
  and `withRemoteTrace()` exist; the outbox relay and the internal HTTP clients wire them in when
  they are built.
