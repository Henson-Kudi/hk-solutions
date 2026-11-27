import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { HealthRegistry } from './health';
import { createHttpServerMetrics, createMetrics } from './metrics';
import {
  currentTraceIds,
  startTracing,
  traceHeaders,
  withRemoteTrace,
  withSpan,
  type Tracing,
} from './tracing';

describe('tracing', () => {
  describe('when not configured', () => {
    it('is off, and spans are harmless no-ops', async () => {
      const tracing = startTracing({ serviceName: 'sales' });
      expect(tracing.enabled).toBe(false);
      await expect(withSpan('work', () => 42)).resolves.toBe(42);
      expect(currentTraceIds()).toBeUndefined();
      expect(traceHeaders()).toEqual({});
      await expect(tracing.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('when configured', () => {
    let exporter: InMemorySpanExporter;
    let tracing: Tracing;

    beforeEach(() => {
      exporter = new InMemorySpanExporter();
      tracing = startTracing({
        serviceName: 'sales',
        serviceVersion: '1.2.3',
        environment: 'test',
        exporter,
      });
    });

    afterEach(async () => {
      await tracing.shutdown();
    });

    it('records a span with its attributes and the service resource', async () => {
      expect(tracing.enabled).toBe(true);
      const result = await withSpan('issue-invoice', async () => 'done', {
        'invoice.lines': 3,
      });
      expect(result).toBe('done');

      const [span] = exporter.getFinishedSpans();
      expect(span?.name).toBe('issue-invoice');
      expect(span?.attributes).toEqual({ 'invoice.lines': 3 });
      expect(span?.resource.attributes).toMatchObject({
        'service.name': 'sales',
        'service.version': '1.2.3',
        'deployment.environment.name': 'test',
      });
    });

    it('exposes the active ids and nests child spans under the parent', async () => {
      let outer: ReturnType<typeof currentTraceIds>;
      let inner: ReturnType<typeof currentTraceIds>;
      await withSpan('outer', async () => {
        outer = currentTraceIds();
        await withSpan('inner', () => {
          inner = currentTraceIds();
        });
      });
      expect(outer?.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(inner?.traceId).toBe(outer?.traceId);
      expect(inner?.spanId).not.toBe(outer?.spanId);
      expect(currentTraceIds()).toBeUndefined();

      const spans = exporter.getFinishedSpans();
      const innerSpan = spans.find((span) => span.name === 'inner');
      expect(innerSpan?.parentSpanContext?.spanId).toBe(outer?.spanId);
    });

    it('marks the span failed and rethrows the same error', async () => {
      const failure = new Error('ledger unavailable');
      await expect(
        withSpan('post-journal', () => {
          throw failure;
        }),
      ).rejects.toBe(failure);

      const [span] = exporter.getFinishedSpans();
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.events.map((event) => event.name)).toEqual(['exception']);
    });

    it('passes the trace to the next service and continues one that arrives', async () => {
      let sent: Record<string, string> = {};
      let sentTraceId: string | undefined;
      await withSpan('caller', () => {
        sent = traceHeaders();
        sentTraceId = currentTraceIds()?.traceId;
      });
      expect(sent['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

      let receivedTraceId: string | undefined;
      await withRemoteTrace(sent, () =>
        withSpan('callee', () => {
          receivedTraceId = currentTraceIds()?.traceId;
        }),
      );
      expect(receivedTraceId).toBe(sentTraceId);
    });
  });
});

describe('metrics', () => {
  it('renders counters, gauges and histograms with the service label', async () => {
    const metrics = createMetrics({ service: 'sales', processMetrics: false });
    const issued = metrics.counter({
      name: 'invoices_issued_total',
      help: 'Invoices issued.',
      labels: ['country'],
    });
    const open = metrics.gauge({
      name: 'cash_sessions_open',
      help: 'Open cash sessions.',
    });
    const duration = metrics.histogram({
      name: 'posting_duration_seconds',
      help: 'Time to post a journal.',
      buckets: [0.1, 1],
    });

    issued.inc({ country: 'CM' });
    issued.inc({ country: 'CM' });
    open.set(4);
    duration.observe(0.05);

    const { contentType, body } = await metrics.render();
    expect(contentType).toContain('text/plain');
    expect(body).toContain(
      'invoices_issued_total{country="CM",service="sales"} 2',
    );
    expect(body).toContain('cash_sessions_open{service="sales"} 4');
    expect(body).toContain(
      'posting_duration_seconds_bucket{le="0.1",service="sales"} 1',
    );
  });

  it('includes Node process metrics unless told not to', async () => {
    const withProcess = createMetrics({ service: 'sales' });
    const without = createMetrics({ service: 'sales', processMetrics: false });
    expect((await withProcess.render()).body).toContain(
      'process_cpu_user_seconds_total',
    );
    expect((await without.render()).body).toBe('\n');
    withProcess.registry.clear();
  });

  it('keeps two services apart: nothing is global', async () => {
    const sales = createMetrics({ service: 'sales', processMetrics: false });
    const core = createMetrics({ service: 'core', processMetrics: false });
    const definition = { name: 'jobs_total', help: 'Jobs.' };
    sales.counter(definition).inc();
    expect(() => core.counter(definition)).not.toThrow();
    expect((await core.render()).body).toContain(
      'jobs_total{service="core"} 0',
    );
  });

  it('records HTTP requests by method, route pattern and status', async () => {
    const metrics = createMetrics({ service: 'sales', processMetrics: false });
    const http = createHttpServerMetrics(metrics);
    http.observe({
      method: 'GET',
      route: '/invoices/:id',
      status: 200,
      durationSeconds: 0.02,
    });
    const { body } = await metrics.render();
    const count = body
      .split('\n')
      .find((line) =>
        line.startsWith('http_server_request_duration_seconds_count'),
      );
    expect(count).toMatch(/ 1$/);
    expect(count).toContain('method="GET"');
    expect(count).toContain('route="/invoices/:id"');
    expect(count).toContain('status="200"');
    expect(count).toContain('service="sales"');
  });
});

describe('HealthRegistry', () => {
  it('is ok with no checks', async () => {
    await expect(new HealthRegistry().run('readiness')).resolves.toEqual({
      status: 'ok',
      checks: {},
    });
  });

  it('runs only the checks of the requested kind', async () => {
    const ran: string[] = [];
    const registry = new HealthRegistry()
      .register({
        name: 'loop',
        kind: 'liveness',
        check: () => ran.push('loop'),
      })
      .register({
        name: 'postgres',
        kind: 'readiness',
        check: async () => ran.push('postgres'),
      });

    const live = await registry.run('liveness');
    expect(ran).toEqual(['loop']);
    expect(live.status).toBe('ok');
    expect(Object.keys(live.checks)).toEqual(['loop']);

    const ready = await registry.run('readiness');
    expect(Object.keys(ready.checks)).toEqual(['postgres']);
  });

  it('reports a failing check without leaking its error', async () => {
    const failures: unknown[] = [];
    const registry = new HealthRegistry({
      onFailure: (check, error) => failures.push([check, error]),
    })
      .register({ name: 'redis', kind: 'readiness', check: () => 'PONG' })
      .register({
        name: 'postgres',
        kind: 'readiness',
        check: () => {
          throw new Error('password authentication failed for user "sales"');
        },
      });

    const report = await registry.run('readiness');
    expect(report.status).toBe('error');
    expect(report.checks['redis']?.status).toBe('ok');
    expect(report.checks['postgres']?.status).toBe('failed');
    expect(JSON.stringify(report)).not.toContain('password');
    expect(failures).toEqual([
      [
        { name: 'postgres', kind: 'readiness' },
        new Error('password authentication failed for user "sales"'),
      ],
    ]);
  });

  it('fails a check that takes too long', async () => {
    let release: () => void = () => undefined;
    const registry = new HealthRegistry().register({
      name: 'slow',
      kind: 'readiness',
      timeoutMs: 20,
      check: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const report = await registry.run('readiness');
    release();
    expect(report).toMatchObject({
      status: 'error',
      checks: { slow: { status: 'timeout' } },
    });
  });

  it('measures how long each check took', async () => {
    const times = [1000, 1042];
    const registry = new HealthRegistry({
      now: () => times.shift() ?? 1042,
    }).register({ name: 'db', kind: 'readiness', check: () => undefined });
    const report = await registry.run('readiness');
    expect(report.checks['db']).toEqual({ status: 'ok', durationMs: 42 });
  });

  it('refuses two checks with the same name', () => {
    const registry = new HealthRegistry().register({
      name: 'db',
      kind: 'readiness',
      check: () => undefined,
    });
    expect(() =>
      registry.register({
        name: 'db',
        kind: 'liveness',
        check: () => undefined,
      }),
    ).toThrow(/already registered/);
  });
});
