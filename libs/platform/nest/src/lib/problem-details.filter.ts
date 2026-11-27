import {
  AppError,
  PROBLEM_CONTENT_TYPE,
  statusOf,
  toProblemDetails,
} from '@hk/platform/errors';
import type { Logger } from '@hk/platform/logger';
import { currentTraceIds } from '@hk/platform/observability';
import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { currentRequestId } from './request-context';
import { LOGGER } from './tokens';

const CODES: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  408: 'REQUEST_TIMEOUT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

const MESSAGES: Readonly<Record<number, string>> = {
  400: 'The request could not be understood.',
  401: 'Authentication is required.',
  403: 'You do not have permission to do this.',
  404: 'The resource was not found.',
  405: 'This method is not allowed here.',
  413: 'The request body is too large.',
  415: 'This content type is not supported.',
  429: 'Too many requests. Try again later.',
  503: 'The service is temporarily unavailable.',
};

const codeFor = (status: number): string => CODES[status] ?? `HTTP_${status}`;

const messageFor = (status: number): string =>
  MESSAGES[status] ?? 'The request could not be completed.';

interface HttpLikeError {
  status?: unknown;
  statusCode?: unknown;
  expose?: unknown;
}

/**
 * Brings errors that did not come from our own code into the AppError shape:
 * Nest's HttpException (unknown route, guard rejection) and the errors Express
 * middleware raises (malformed JSON, body too large).
 *
 * Their messages are replaced with fixed ones. A framework message can quote
 * the request, and what the caller sees should not depend on framework
 * wording.
 */
const normalise = (exception: unknown): unknown => {
  if (exception instanceof AppError) {
    return exception;
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return new AppError(codeFor(status), status, messageFor(status), {
      cause: exception,
    });
  }
  if (typeof exception === 'object' && exception !== null) {
    const candidate = exception as HttpLikeError;
    const status = candidate.status ?? candidate.statusCode;
    if (
      candidate.expose === true &&
      typeof status === 'number' &&
      status >= 400 &&
      status < 500
    ) {
      return new AppError(codeFor(status), status, messageFor(status), {
        cause: exception,
      });
    }
  }
  return exception;
};

/**
 * Turns every error an HTTP handler throws into an RFC 9457 problem-details
 * response (see @hk/platform/errors), and logs it.
 *
 * A 5xx is logged as an error with the original exception. A 4xx is the
 * caller's mistake and is logged at info level with its code only.
 *
 *   app.useGlobalFilters(new ProblemDetailsFilter(app.get(HttpAdapterHost), logger));
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }
    const { httpAdapter } = this.adapterHost;
    const http = host.switchToHttp();
    const request = http.getRequest<object>();
    const response = http.getResponse<object>();

    const error = normalise(exception);
    const status = statusOf(error);
    const instance = String(httpAdapter.getRequestUrl(request)).split('?')[0];
    const traceId = currentTraceIds()?.traceId;
    const requestId = currentRequestId();
    const problem = toProblemDetails(error, {
      ...(instance === undefined ? {} : { instance }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(traceId === undefined ? {} : { traceId }),
    });

    if (status >= 500) {
      this.logger.error('request failed', {
        status,
        code: problem.code,
        err: exception,
      });
    } else {
      this.logger.info('request rejected', { status, code: problem.code });
    }

    if (error instanceof AppError) {
      for (const [name, value] of Object.entries(error.headers)) {
        httpAdapter.setHeader(response, name, value);
      }
    }
    httpAdapter.setHeader(response, 'Content-Type', PROBLEM_CONTENT_TYPE);
    httpAdapter.reply(response, JSON.stringify(problem), status);
  }
}
