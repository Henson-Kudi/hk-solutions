# @hk/platform/nest

What every NestJS HTTP service shares. Nothing here is `@Global()`: a module imports what it uses.

```ts
// main.ts
const app = await NestFactory.create(AppModule, {
  logger: new NestLoggerAdapter(logger),
});
setupHttpApp(app, { logger, metrics: createHttpServerMetrics(metrics) });
await app.listen(config.PORT);

// app.module.ts
@Module({
  imports: [LoggerModule.register(logger), ObservabilityModule.register({ health, metrics })],
})
export class AppModule {}
```

`setupHttpApp` installs, in this order:

| Piece                  | What it does                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `requestContext()`     | Takes `X-Request-Id` from the caller when acceptable, otherwise makes one. Echoes it on the response and puts it on every log line.       |
| `requestLogging()`     | One line and one duration sample per request: method, **route pattern**, status, duration. Never the query string, headers or bodies.     |
| `ProblemDetailsFilter` | Every error becomes a problem-details response (see `@hk/platform/errors`). A 5xx is logged with the exception, a 4xx with its code only. |
| shutdown hooks         | `SIGTERM` closes the app cleanly.                                                                                                         |

Also here:

- `ZodValidationPipe`: `@Body(new ZodValidationPipe(schema)) input`. A failure is a 400 listing each
  invalid field.
- `@RequestId()` handler parameter, and `currentRequestId()` anywhere.
- `LOGGER` injection token: `constructor(@Inject(LOGGER) private readonly logger: Logger)`.
- `ObservabilityModule`: `GET /health/live`, `GET /health/ready` (503 when a dependency is down) and
  `GET /metrics`. They are open and return no error text. The gateway must not route them.

## Idempotent writes

Every POST, PUT, PATCH and DELETE handler carries exactly one of these (ADR 0006):

```ts
@Post()
@Idempotent() // needs an Idempotency-Key header; runs at most once per key
create(@Body(new ZodValidationPipe(schema)) input: CreatePayment) {}

@Post('webhooks/mtn')
@IdempotencyExempt('deduplicated on the provider reference')
webhook() {}
```

Install the interceptor once per app:

```ts
providers: [
  { provide: IDEMPOTENCY, useValue: createIdempotency({ database, table: idempotencyKeys }) },
  { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
],
```

- An `@Idempotent()` handler runs inside the transaction that records the key, so its writes roll
  back if it throws. Keep it short and never call a remote service in it.
- A replay returns the stored status and body with `Idempotent-Replayed: true`.
- **It fails closed:** a write handler with neither decorator is answered 500 and does not run.
- Every service has this test, so a forgotten handler fails CI:

  ```ts
  expect(findUncoveredRoutes([PaymentsController, InvoicesController])).toEqual([]);
  ```

Request context and logging are middleware, not interceptors, because they must wrap guards, pipes
and filters and see the final status. They expect the Express adapter.

## Tests

NestJS 12 is ESM-only, so this lib's `test` target runs Jest with
`NODE_OPTIONS=--experimental-vm-modules` (see ADR 0003). Any lib whose tests import NestJS needs the
same setting; `nx g @nx/nest:lib` adds it.
