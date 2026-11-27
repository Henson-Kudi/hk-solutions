import {
  DomainError,
  type DomainErrorDetails,
  type DomainErrorKind,
} from '@hk/platform/universal';
import { defaultRedactor, type Redactor } from '@hk/platform/redaction';
import { AppError, RequestValidationError, type FieldIssue } from './app-error';

/** The media type of an error response (RFC 9457). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * The body of every error response, following RFC 9457 "Problem Details for
 * HTTP APIs" with three extension members: `code`, `details` and `errors`.
 *
 * Clients branch on `code` and translate it; `title` and `detail` are English
 * text for developers.
 */
export interface ProblemDetails {
  /** Always "about:blank": the stable identifier is `code`. */
  type: string;
  title: string;
  status: number;
  /** Stable UPPER_SNAKE identifier. The i18n key for the user-facing text. */
  code: string;
  detail?: string;
  /** The request path. */
  instance?: string;
  requestId?: string;
  traceId?: string;
  /** Values that belong to the message, for example the two currencies of a mismatch. */
  details?: DomainErrorDetails;
  /** Field-by-field problems, on a REQUEST_INVALID response. */
  errors?: readonly FieldIssue[];
}

export interface ProblemContext {
  instance?: string;
  requestId?: string;
  traceId?: string;
  /**
   * Applied to everything in the body that comes from the error: `detail`,
   * `details` and the field messages. Defaults to the redactor of
   * @hk/platform/redaction. An error message or its details can quote user
   * input, and a response must not echo a secret back.
   */
  redactor?: Redactor;
}

/**
 * validation  422  the request was understood but breaks a business rule
 * not-found   404
 * conflict    409  the resource is not in a state that allows this
 * forbidden   403
 * invariant   500  the code is wrong; the caller cannot fix it
 */
export const STATUS_FOR_KIND: Readonly<Record<DomainErrorKind, number>> = {
  validation: 422,
  'not-found': 404,
  conflict: 409,
  forbidden: 403,
  invariant: 500,
};

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';

const titleFor = (status: number): string =>
  TITLES[status] ?? (status >= 500 ? 'Server Error' : 'Request Error');

const hasEntries = (value: object): boolean => Object.keys(value).length > 0;

const build = (
  status: number,
  code: string,
  context: ProblemContext,
  raw: Pick<ProblemDetails, 'detail' | 'details' | 'errors'> = {},
): ProblemDetails => {
  const redactor = context.redactor ?? defaultRedactor;
  const extra = {
    detail:
      raw.detail === undefined ? undefined : redactor.redactText(raw.detail),
    details:
      raw.details === undefined ? undefined : redactor.redact(raw.details),
    errors: raw.errors?.map((issue) => ({
      ...issue,
      message: redactor.redactText(issue.message),
    })),
  };
  return {
    type: 'about:blank',
    title: titleFor(status),
    status,
    code,
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    ...(context.instance === undefined ? {} : { instance: context.instance }),
    ...(context.requestId === undefined
      ? {}
      : { requestId: context.requestId }),
    ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
    ...(extra.details && hasEntries(extra.details)
      ? { details: extra.details }
      : {}),
    ...(extra.errors ? { errors: extra.errors } : {}),
  };
};

/** The response for anything the caller must not learn more about. */
const internal = (status: number, context: ProblemContext): ProblemDetails =>
  build(
    status,
    status === 500 ? INTERNAL_ERROR_CODE : 'SERVICE_ERROR',
    context,
  );

/**
 * Turns anything that was thrown into the body of an error response.
 *
 * A status of 500 or above never exposes the original message, code or
 * details: the caller gets a generic body plus the request and trace ids that
 * find the real error in the logs.
 */
export const toProblemDetails = (
  error: unknown,
  context: ProblemContext = {},
): ProblemDetails => {
  if (error instanceof RequestValidationError) {
    return build(error.status, error.code, context, {
      detail: error.message,
      errors: error.issues,
    });
  }
  if (error instanceof AppError) {
    if (error.status >= 500) {
      return error.status === 500
        ? internal(500, context)
        : build(error.status, error.code, context, { detail: error.message });
    }
    return build(error.status, error.code, context, {
      detail: error.message,
      details: error.details,
    });
  }
  if (error instanceof DomainError) {
    const status = STATUS_FOR_KIND[error.kind];
    if (status >= 500) {
      return internal(status, context);
    }
    return build(status, error.code, context, {
      detail: error.message,
      details: error.details,
    });
  }
  return internal(500, context);
};

/** The HTTP status toProblemDetails would give this error. */
export const statusOf = (error: unknown): number => {
  if (error instanceof AppError) {
    return error.status;
  }
  if (error instanceof DomainError) {
    return STATUS_FOR_KIND[error.kind];
  }
  return 500;
};

/**
 * True when the failure is the caller's (a 4xx). These are expected in normal
 * operation and are not logged as errors.
 */
export const isClientError = (error: unknown): boolean => {
  const status = statusOf(error);
  return status >= 400 && status < 500;
};

/** True when a parsed response body has the shape this lib produces. */
export const isProblemDetails = (value: unknown): value is ProblemDetails => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof ProblemDetails, unknown>>;
  return (
    typeof candidate.status === 'number' &&
    typeof candidate.code === 'string' &&
    typeof candidate.title === 'string'
  );
};
