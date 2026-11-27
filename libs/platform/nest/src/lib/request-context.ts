import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getLogContext,
  runWithLogContext,
  type Logger,
} from '@hk/platform/logger';
import type { HttpServerMetrics } from '@hk/platform/observability';
import { uuidv7 } from '@hk/platform/universal';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export const REQUEST_ID_HEADER = 'x-request-id';

/** What a caller may send as a request id. Anything else is replaced, so a header cannot inject text into logs. */
const ACCEPTABLE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

type Next = (error?: unknown) => void;

/** The parts of an Express request this file reads. */
interface RoutedRequest extends IncomingMessage {
  requestId?: string;
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: unknown };
}

export interface RequestContextOptions {
  /** Defaults to a UUID v7. */
  generateId?: () => string;
}

/**
 * Gives every request an id and runs the rest of the request inside a log
 * context that carries it.
 *
 * The id comes from the X-Request-Id header when the caller sent an acceptable
 * one (the gateway does, and services pass it on), otherwise a new one is
 * made. It is echoed on the response, so a user can quote it to support.
 *
 * This is middleware and not an interceptor because the context must wrap the
 * whole request, including guards, pipes and exception filters.
 *
 *   app.use(requestContext());
 */
export const requestContext = (options: RequestContextOptions = {}) => {
  const generateId = options.generateId ?? uuidv7;
  return (request: RoutedRequest, response: ServerResponse, next: Next) => {
    const incoming = request.headers[REQUEST_ID_HEADER];
    const requestId =
      typeof incoming === 'string' && ACCEPTABLE_REQUEST_ID.test(incoming)
        ? incoming
        : generateId();
    request.requestId = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    runWithLogContext({ requestId }, () => next());
  };
};

/** The id of the request being handled, or undefined outside a request. */
export const currentRequestId = (): string | undefined => {
  const requestId = getLogContext()?.['requestId'];
  return typeof requestId === 'string' ? requestId : undefined;
};

/**
 * Handler parameter that receives the request id:
 *
 *   @Get() list(@RequestId() requestId: string) {}
 */
export const RequestId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<RoutedRequest>().requestId,
);

const pathOf = (request: RoutedRequest): string =>
  (request.originalUrl ?? request.url ?? '').split('?')[0] ?? '';

/**
 * The route pattern that handled the request, such as /invoices/:id. A
 * request that matched no route is "unmatched", so a scan of random URLs
 * cannot create a metric series per URL.
 */
const routeOf = (request: RoutedRequest): string =>
  typeof request.route?.path === 'string'
    ? `${request.baseUrl ?? ''}${request.route.path}`
    : 'unmatched';

export interface RequestLoggingOptions {
  logger: Logger;
  metrics?: HttpServerMetrics;
  /** Paths that are not logged or measured. Defaults to /health/* and /metrics. */
  ignore?: (path: string) => boolean;
}

const isProbe = (path: string): boolean =>
  path === '/metrics' || path.startsWith('/health/');

/**
 * Writes one line per finished request and records its duration.
 *
 * It logs the method, the route pattern, the status and the duration. It
 * never logs the query string, headers or bodies, and it logs the route
 * pattern instead of the path because paths can hold identifiers.
 *
 * Install it after requestContext(), so the line carries the request id:
 *
 *   app.use(requestContext());
 *   app.use(requestLogging({ logger, metrics }));
 */
export const requestLogging = (options: RequestLoggingOptions) => {
  const ignore = options.ignore ?? isProbe;
  return (request: RoutedRequest, response: ServerResponse, next: Next) => {
    if (ignore(pathOf(request))) {
      next();
      return;
    }
    const startedAt = process.hrtime.bigint();
    response.once('finish', () => {
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      const method = request.method ?? 'UNKNOWN';
      const route = routeOf(request);
      const status = response.statusCode;
      options.metrics?.observe({ method, route, status, durationSeconds });
      const fields = {
        method,
        route,
        status,
        durationMs: Math.round(durationSeconds * 1_000),
      };
      if (status >= 500) {
        options.logger.error('request completed', fields);
      } else {
        options.logger.info('request completed', fields);
      }
    });
    next();
  };
};
