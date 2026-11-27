import {
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export interface TracingOptions {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  /**
   * Base URL of an OTLP/HTTP collector, for example http://localhost:4318.
   * Tracing stays off when neither this nor `exporter` is given.
   */
  otlpEndpoint?: string;
  /** Share of new traces to record, 0 to 1. A request that arrives already traced keeps its parent's decision. */
  sampleRatio?: number;
  /** For tests: where spans go instead of the collector. Spans are then exported one by one. */
  exporter?: SpanExporter;
}

export interface Tracing {
  /** False when no endpoint was configured. Spans are then no-ops and cost almost nothing. */
  enabled: boolean;
  /** Sends what is buffered and stops. Call it during graceful shutdown. */
  shutdown(): Promise<void>;
}

const TRACER_NAME = '@hk/platform/observability';

/**
 * Starts OpenTelemetry tracing for the process. Call it once, first thing in
 * the service's main file, before the modules it should observe are loaded.
 *
 * It registers W3C trace-context propagation, so a `traceparent` header that
 * arrives on a request continues the caller's trace, and traceHeaders()
 * passes it on to the next service.
 */
export const startTracing = (options: TracingOptions): Tracing => {
  const exporter =
    options.exporter ??
    (options.otlpEndpoint === undefined
      ? undefined
      : new OTLPTraceExporter({
          url: `${options.otlpEndpoint.replace(/\/+$/, '')}/v1/traces`,
        }));

  if (!exporter) {
    return { enabled: false, shutdown: async () => undefined };
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      ...(options.serviceVersion === undefined
        ? {}
        : { [ATTR_SERVICE_VERSION]: options.serviceVersion }),
      ...(options.environment === undefined
        ? {}
        : { 'deployment.environment.name': options.environment }),
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(options.sampleRatio ?? 1),
    }),
    spanProcessors: [
      options.exporter
        ? new SimpleSpanProcessor(exporter)
        : new BatchSpanProcessor(exporter),
    ],
  });
  provider.register();

  return {
    enabled: true,
    shutdown: async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
};

export interface TraceIds {
  traceId: string;
  spanId: string;
}

/** The ids of the span that is active right now, for log lines and error responses. */
export const currentTraceIds = (): TraceIds | undefined => {
  const active = trace.getActiveSpan()?.spanContext();
  return active && trace.isSpanContextValid(active)
    ? { traceId: active.traceId, spanId: active.spanId }
    : undefined;
};

/**
 * Headers that continue the current trace in the service being called
 * (`traceparent`, and `tracestate` when present). Empty outside a trace.
 */
export const traceHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  return headers;
};

/**
 * Runs `action` inside the trace described by incoming headers. A queue worker
 * uses this to continue the trace of the request that enqueued the job.
 */
export const withRemoteTrace = <T>(
  headers: Readonly<Record<string, string | undefined>>,
  action: () => T,
): T => context.with(propagation.extract(context.active(), headers), action);

/**
 * Runs `action` in a new span. If it throws or rejects, the span records the
 * exception and is marked failed, and the error is rethrown unchanged.
 *
 * Attribute values end up in the tracing backend: the logging rules apply to
 * them too. No tokens, OTPs, ID numbers, phone numbers or request bodies.
 */
export const withSpan = async <T>(
  name: string,
  action: (span: Span) => Promise<T> | T,
  attributes: Attributes = {},
): Promise<T> =>
  trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(name, { attributes }, async (span) => {
      try {
        return await action(span);
      } catch (error) {
        span.recordException(
          error instanceof Error ? error : new Error('non-error thrown'),
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
