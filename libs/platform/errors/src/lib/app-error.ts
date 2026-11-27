import type { DomainErrorDetails } from '@hk/platform/universal';

export interface AppErrorOptions {
  details?: DomainErrorDetails;
  cause?: unknown;
  /** Extra response headers, for example Retry-After on a 429. */
  headers?: Readonly<Record<string, string>>;
}

/**
 * A failure that belongs to the transport or the infrastructure, not to a
 * business rule: a malformed request, a missing credential, a dependency that
 * is down. Business rules throw DomainError from @hk/platform/universal.
 *
 * `code` is a stable UPPER_SNAKE identifier, as on DomainError. `status` is
 * the HTTP status the caller should see. For a status below 500 the message
 * is shown to the caller, so keep it free of internal detail.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: DomainErrorDetails;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    code: string,
    status: number,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = Object.freeze({ ...options.details });
    this.headers = Object.freeze({ ...options.headers });
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** One problem with one field of a request. */
export interface FieldIssue {
  /** Dotted path into the request, for example "lines.0.quantity". Empty for the whole body. */
  path: string;
  /** Stable identifier, usable as an i18n key. */
  code: string;
  message: string;
}

/** The request did not have the shape the endpoint requires. Always a 400. */
export class RequestValidationError extends AppError {
  readonly issues: readonly FieldIssue[];

  constructor(issues: readonly FieldIssue[]) {
    super('REQUEST_INVALID', 400, 'The request is not valid.');
    this.name = 'RequestValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

export const unauthenticated = (
  message = 'Authentication is required.',
): AppError => new AppError('UNAUTHENTICATED', 401, message);

export const permissionDenied = (
  message = 'You do not have permission to do this.',
): AppError => new AppError('PERMISSION_DENIED', 403, message);

export const notFound = (message = 'The resource was not found.'): AppError =>
  new AppError('NOT_FOUND', 404, message);

export const tooManyRequests = (retryAfterSeconds: number): AppError =>
  new AppError('RATE_LIMITED', 429, 'Too many requests. Try again later.', {
    headers: {
      'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
    },
  });

export const serviceUnavailable = (cause?: unknown): AppError =>
  new AppError(
    'SERVICE_UNAVAILABLE',
    503,
    'The service is temporarily unavailable.',
    { cause },
  );
