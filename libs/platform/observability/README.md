# @hk/platform/observability

Tracing, metrics and health checks. Framework-free: `@hk/platform/nest` exposes them over HTTP.

**Tracing** (OpenTelemetry). Off unless an endpoint is configured.

```ts
// first lines of main.ts, before the modules it should observe are loaded
const tracing = startTracing({
  serviceName: 'sales',
  otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
});

await withSpan('issue-invoice', () => issueInvoice(input), { 'invoice.lines': 3 });
```

`traceHeaders()` gives the headers that continue the trace in the next service, and
`withRemoteTrace(headers, fn)` continues one that arrived. Span attributes follow the logging
rules: no tokens, OTPs, ID numbers, phone numbers or bodies.

**Metrics** (Prometheus). One registry per service, nothing global.

```ts
const metrics = createMetrics({ service: 'sales' });
const issued = metrics.counter({
  name: 'invoices_issued_total',
  help: 'Invoices issued.',
  labels: ['country'],
});
issued.inc({ country });
```

Label values must come from a small fixed set. Never a tenant, user or document id: each distinct
value is a new time series.

**Health.**

```ts
const health = new HealthRegistry({
  onFailure: (check, err) => logger.warn('health check failed', { check: check.name, err }),
}).register({ name: 'redis', kind: 'readiness', check: () => pingRedis(redis) });
```

- `liveness`: is the process working? Never put a dependency here, or an outage restarts every pod.
- `readiness`: can it serve traffic now? Dependencies go here.
- The report holds `ok`, `failed` or `timeout` per check and no error text, because the endpoint is
  open.
