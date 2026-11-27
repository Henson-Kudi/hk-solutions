import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export interface MetricsOptions {
  /** Added to every series as the label `service`. */
  service: string;
  /** Collect Node process metrics (memory, CPU, event loop, GC). Defaults to true. */
  processMetrics?: boolean;
}

export interface MetricDefinition<Label extends string> {
  /** snake_case, with the unit as a suffix: `invoices_issued_total`, `posting_duration_seconds`. */
  name: string;
  help: string;
  /**
   * Label names. Keep the set of possible values small and fixed (a status, a
   * route pattern, a country). Never a tenant, user or document id: each
   * distinct value creates a new time series.
   */
  labels?: readonly Label[];
}

export interface HistogramDefinition<Label extends string>
  extends MetricDefinition<Label> {
  /** Upper bounds in the metric's unit. Defaults suit request durations in seconds. */
  buckets?: number[];
}

export interface Metrics {
  /** This service's own registry. Nothing is registered globally. */
  registry: Registry;
  counter<Label extends string = never>(
    definition: MetricDefinition<Label>,
  ): Counter<Label>;
  gauge<Label extends string = never>(
    definition: MetricDefinition<Label>,
  ): Gauge<Label>;
  histogram<Label extends string = never>(
    definition: HistogramDefinition<Label>,
  ): Histogram<Label>;
  /** The text a Prometheus scrape of /metrics returns. */
  render(): Promise<{ contentType: string; body: string }>;
}

export const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export const createMetrics = (options: MetricsOptions): Metrics => {
  const registry = new Registry();
  registry.setDefaultLabels({ service: options.service });
  if (options.processMetrics ?? true) {
    collectDefaultMetrics({ register: registry });
  }

  return {
    registry,
    counter: (definition) =>
      new Counter({
        name: definition.name,
        help: definition.help,
        labelNames: [...(definition.labels ?? [])],
        registers: [registry],
      }),
    gauge: (definition) =>
      new Gauge({
        name: definition.name,
        help: definition.help,
        labelNames: [...(definition.labels ?? [])],
        registers: [registry],
      }),
    histogram: (definition) =>
      new Histogram({
        name: definition.name,
        help: definition.help,
        labelNames: [...(definition.labels ?? [])],
        buckets: definition.buckets ?? DURATION_BUCKETS_SECONDS,
        registers: [registry],
      }),
    render: async () => ({
      contentType: registry.contentType,
      body: await registry.metrics(),
    }),
  };
};

export interface HttpServerMetrics {
  /** Record one finished request. `route` is the pattern (/invoices/:id), never the raw path. */
  observe(labels: {
    method: string;
    route: string;
    status: number;
    durationSeconds: number;
  }): void;
}

/** The standard request metric every HTTP service exposes. */
export const createHttpServerMetrics = (
  metrics: Metrics,
): HttpServerMetrics => {
  const duration = metrics.histogram({
    name: 'http_server_request_duration_seconds',
    help: 'Duration of handled HTTP requests in seconds.',
    labels: ['method', 'route', 'status'],
  });
  return {
    observe: ({ method, route, status, durationSeconds }) => {
      duration.observe(
        { method, route, status: String(status) },
        durationSeconds,
      );
    },
  };
};
