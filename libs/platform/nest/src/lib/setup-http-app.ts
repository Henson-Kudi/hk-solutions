import type { Logger } from '@hk/platform/logger';
import type { HttpServerMetrics } from '@hk/platform/observability';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ProblemDetailsFilter } from './problem-details.filter';
import { requestContext, requestLogging } from './request-context';

export interface HttpAppOptions {
  logger: Logger;
  /** Records request durations when given. */
  metrics?: HttpServerMetrics;
}

/**
 * Applies what every HTTP service needs, in the order that matters:
 *
 * 1. request id and log context, around everything else;
 * 2. one log line and one duration sample per request;
 * 3. problem-details responses for every error;
 * 4. shutdown hooks, so SIGTERM closes connections cleanly.
 *
 * Call it in main.ts between NestFactory.create() and app.listen(). It
 * expects the Express adapter.
 */
export const setupHttpApp = (
  app: INestApplication,
  options: HttpAppOptions,
): void => {
  app.use(requestContext());
  app.use(
    requestLogging({
      logger: options.logger,
      ...(options.metrics ? { metrics: options.metrics } : {}),
    }),
  );
  app.useGlobalFilters(
    new ProblemDetailsFilter(app.get(HttpAdapterHost), options.logger),
  );
  app.enableShutdownHooks();
};
