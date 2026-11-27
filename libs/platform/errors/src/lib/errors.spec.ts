import { DomainError } from '@hk/platform/universal';
import {
  AppError,
  RequestValidationError,
  notFound,
  permissionDenied,
  serviceUnavailable,
  tooManyRequests,
  unauthenticated,
} from './app-error';
import {
  isClientError,
  isProblemDetails,
  statusOf,
  toProblemDetails,
} from './problem-details';

const context = {
  instance: '/sales/invoices',
  requestId: 'req-1',
  traceId: 'trace-1',
};

describe('toProblemDetails', () => {
  it.each([
    ['validation', 422, 'Unprocessable Content'],
    ['not-found', 404, 'Not Found'],
    ['conflict', 409, 'Conflict'],
    ['forbidden', 403, 'Forbidden'],
  ] as const)('maps a %s DomainError to %i', (kind, status, title) => {
    const error = new DomainError('INVOICE_RULE', 'Invoice rule failed.', {
      kind,
      details: { invoiceStatus: 'ISSUED' },
    });
    expect(toProblemDetails(error, context)).toEqual({
      type: 'about:blank',
      title,
      status,
      code: 'INVOICE_RULE',
      detail: 'Invoice rule failed.',
      instance: '/sales/invoices',
      requestId: 'req-1',
      traceId: 'trace-1',
      details: { invoiceStatus: 'ISSUED' },
    });
    expect(statusOf(error)).toBe(status);
    expect(isClientError(error)).toBe(true);
  });

  it('hides everything about an invariant failure', () => {
    const error = new DomainError(
      'MONEY_CURRENCY_MISMATCH',
      'Amounts in different currencies cannot be combined.',
      { kind: 'invariant', details: { left: 'XAF', right: 'AED' } },
    );
    const problem = toProblemDetails(error, context);
    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL_ERROR',
      instance: '/sales/invoices',
      requestId: 'req-1',
      traceId: 'trace-1',
    });
    expect(JSON.stringify(problem)).not.toContain('XAF');
    expect(isClientError(error)).toBe(false);
  });

  it.each([
    new Error('connect ECONNREFUSED 10.0.0.5:5432'),
    new TypeError("Cannot read properties of undefined (reading 'id')"),
    'a thrown string',
    null,
    { status: 418, code: 'TEAPOT' },
  ])('answers 500 without leaking for an unknown throw: %p', (thrown) => {
    const problem = toProblemDetails(thrown);
    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL_ERROR',
    });
    expect(statusOf(thrown)).toBe(500);
  });

  it('omits details when there are none, and context when not given', () => {
    const problem = toProblemDetails(new DomainError('NAME_REQUIRED', 'Name.'));
    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Unprocessable Content',
      status: 422,
      code: 'NAME_REQUIRED',
      detail: 'Name.',
    });
  });

  it('lists field issues for an invalid request', () => {
    const error = new RequestValidationError([
      { path: 'lines.0.quantity', code: 'too_small', message: 'Too small.' },
    ]);
    expect(toProblemDetails(error)).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      code: 'REQUEST_INVALID',
      detail: 'The request is not valid.',
      errors: [
        { path: 'lines.0.quantity', code: 'too_small', message: 'Too small.' },
      ],
    });
  });

  it('maps the ready-made AppErrors', () => {
    expect(toProblemDetails(unauthenticated())).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
    expect(toProblemDetails(permissionDenied())).toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(toProblemDetails(notFound())).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(toProblemDetails(tooManyRequests(2.2))).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      title: 'Too Many Requests',
    });
    expect(tooManyRequests(2.2).headers).toEqual({ 'Retry-After': '3' });
    expect(tooManyRequests(0).headers).toEqual({ 'Retry-After': '1' });
  });

  it('keeps the code of a 503 but never its cause', () => {
    const error = serviceUnavailable(new Error('redis://:pw@cache:6379 down'));
    const problem = toProblemDetails(error);
    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      detail: 'The service is temporarily unavailable.',
    });
    expect(JSON.stringify(problem)).not.toContain('redis');
  });

  it('hides an AppError with status 500', () => {
    const error = new AppError('DB_WRITE_FAILED', 500, 'insert into core.x …', {
      details: { table: 'core.x' },
    });
    expect(toProblemDetails(error)).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });

  it('gives an unlisted status a generic title', () => {
    expect(toProblemDetails(new AppError('GONE', 410, 'Gone.')).title).toBe(
      'Request Error',
    );
    expect(toProblemDetails(new AppError('X', 507, 'Full.')).title).toBe(
      'Server Error',
    );
  });
});

describe('isProblemDetails', () => {
  it('recognises the bodies this lib produces', () => {
    expect(isProblemDetails(toProblemDetails(notFound()))).toBe(true);
    expect(
      isProblemDetails(JSON.parse(JSON.stringify(toProblemDetails(null)))),
    ).toBe(true);
  });

  it('rejects other shapes', () => {
    expect(isProblemDetails(null)).toBe(false);
    expect(isProblemDetails('error')).toBe(false);
    expect(isProblemDetails({ message: 'Not Found', statusCode: 404 })).toBe(
      false,
    );
    expect(isProblemDetails({ status: '404', code: 'X', title: 'T' })).toBe(
      false,
    );
  });
});
