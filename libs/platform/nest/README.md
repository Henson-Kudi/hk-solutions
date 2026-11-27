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

Request context and logging are middleware, not interceptors, because they must wrap guards, pipes
and filters and see the final status. They expect the Express adapter.

## Tests

NestJS 12 is ESM-only, so this lib's `test` target runs Jest with
`NODE_OPTIONS=--experimental-vm-modules` (see ADR 0003). Any lib whose tests import NestJS needs the
same setting; `nx g @nx/nest:lib` adds it.
