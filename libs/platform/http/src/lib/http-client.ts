import { isProblemDetails, type ProblemDetails } from '@hk/platform/errors';
import type { Logger } from '@hk/platform/logger';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpClientOptions {
  /** Scheme, host and optional path prefix: "http://core:3000" or "https://api.example.com/v1". */
  baseUrl: string;
  /** Names the service being called, in errors and log lines: "core-api". */
  name: string;
  /** Per attempt. Defaults to 10000. */
  timeoutMs?: number;
  /** Extra attempts after the first, for requests that are safe to repeat. Defaults to 2. */
  retries?: number;
  /**
   * Called for every attempt. Return the headers that carry context to the
   * next service: the trace headers, the request id, the service token.
   */
  headers?: () => Record<string, string>;
  logger?: Logger;
  /** For tests. */
  fetch?: typeof fetch;
  /** For tests. */
  sleep?: (milliseconds: number) => Promise<void>;
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  query?: Readonly<Record<string, QueryValue>>;
  /** Sent as JSON. */
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  /**
   * Sent as the Idempotency-Key header. Giving one is what makes a write safe
   * to retry: without it a POST, PUT, PATCH or DELETE is sent once only.
   */
  idempotencyKey?: string;
  timeoutMs?: number;
  retries?: number;
  /** Lets the caller cancel. A cancelled request is not retried. */
  signal?: AbortSignal;
}

export interface HttpResponse<Data> {
  status: number;
  headers: Headers;
  /** The parsed JSON body, the text of a non-JSON body, or undefined when there is none. */
  data: Data;
}

export type HttpErrorCode =
  /** The server answered with a status of 400 or above. */
  | 'HTTP_RESPONSE'
  /** No answer within the timeout. */
  | 'HTTP_TIMEOUT'
  /** The connection failed or broke. */
  | 'HTTP_NETWORK'
  /** The caller's signal cancelled the request. */
  | 'HTTP_ABORTED'
  /** The answer said JSON but was not. */
  | 'HTTP_INVALID_RESPONSE';

export interface HttpClientErrorInfo {
  client: string;
  method: HttpMethod;
  path: string;
  code: HttpErrorCode;
  status: number;
  attempts: number;
  outcomeUnknown: boolean;
  problem?: ProblemDetails;
  cause?: unknown;
}

/**
 * Every failure of a client call. The message never contains the query
 * string, headers or bodies.
 */
export class HttpClientError extends Error {
  readonly client: string;
  readonly method: HttpMethod;
  /** The path without its query string. */
  readonly path: string;
  readonly code: HttpErrorCode;
  /** The response status, or 0 when there was no response. */
  readonly status: number;
  /** How many times the request was sent. */
  readonly attempts: number;
  /**
   * True when a write may have been applied even though the call failed: it
   * timed out, the connection broke, or the server answered 5xx. The caller
   * must not treat this as "did not happen". Record it as unknown and
   * reconcile, or repeat the call with the same idempotency key.
   */
  readonly outcomeUnknown: boolean;
  /** The error body, when the server sent problem details. */
  readonly problem?: ProblemDetails;

  constructor(info: HttpClientErrorInfo) {
    super(
      `${info.client}: ${info.method} ${info.path} failed (${info.code}${
        info.status ? ` ${info.status}` : ''
      }).`,
    );
    this.name = 'HttpClientError';
    this.client = info.client;
    this.method = info.method;
    this.path = info.path;
    this.code = info.code;
    this.status = info.status;
    this.attempts = info.attempts;
    this.outcomeUnknown = info.outcomeUnknown;
    if (info.problem !== undefined) {
      this.problem = info.problem;
    }
    if (info.cause !== undefined) {
      this.cause = info.cause;
    }
  }
}

export interface HttpClient {
  request<Data = unknown>(
    method: HttpMethod,
    path: string,
    options?: RequestOptions,
  ): Promise<HttpResponse<Data>>;
  get<Data = unknown>(
    path: string,
    options?: Omit<RequestOptions, 'body'>,
  ): Promise<HttpResponse<Data>>;
  post<Data = unknown>(
    path: string,
    options?: RequestOptions,
  ): Promise<HttpResponse<Data>>;
  put<Data = unknown>(
    path: string,
    options?: RequestOptions,
  ): Promise<HttpResponse<Data>>;
  patch<Data = unknown>(
    path: string,
    options?: RequestOptions,
  ): Promise<HttpResponse<Data>>;
  delete<Data = unknown>(
    path: string,
    options?: RequestOptions,
  ): Promise<HttpResponse<Data>>;
}

const READ_METHODS: readonly HttpMethod[] = ['GET', 'HEAD'];
const RETRYABLE_STATUSES = [429, 502, 503, 504];
const MAX_RETRY_DELAY_MS = 10_000;
const BASE_RETRY_DELAY_MS = 100;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Retry-After in seconds, when the server sent a sensible one. */
const retryAfterMs = (headers: Headers | undefined): number | undefined => {
  const value = headers?.get('retry-after');
  if (value === null || value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }
  return Math.min(Number(value) * 1_000, MAX_RETRY_DELAY_MS);
};

const backoffMs = (attempt: number): number => {
  const exponential = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
  // Jitter spreads out callers that all failed at the same moment.
  const jittered = exponential * (0.5 + Math.random() / 2);
  return Math.min(jittered, MAX_RETRY_DELAY_MS);
};

const readBody = async (response: Response): Promise<unknown> => {
  if (response.status === 204 || response.status === 205) {
    return undefined;
  }
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  const type = response.headers.get('content-type') ?? '';
  return /[/+]json\b/i.test(type) ? (JSON.parse(text) as unknown) : text;
};

/**
 * Creates a client for one remote service.
 *
 * Retries: a request is repeated only when repeating is safe, that is a GET
 * or HEAD, or any request that carries an idempotency key. It is repeated
 * after a timeout, a network error, or a 429, 502, 503 or 504, with
 * exponential back-off, honouring Retry-After.
 *
 * Any status of 400 or above throws an HttpClientError.
 */
export const createHttpClient = (options: HttpClientOptions): HttpClient => {
  const base = options.baseUrl.replace(/\/+$/, '');
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const { logger, name } = options;

  const request = async <Data>(
    method: HttpMethod,
    path: string,
    requestOptions: RequestOptions = {},
  ): Promise<HttpResponse<Data>> => {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new Error(
        'Request path must start with a single "/". The host comes from baseUrl.',
      );
    }
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(requestOptions.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const isRead = READ_METHODS.includes(method);
    const repeatable = isRead || requestOptions.idempotencyKey !== undefined;
    const maxAttempts =
      1 + (repeatable ? (requestOptions.retries ?? options.retries ?? 2) : 0);
    const timeoutMs = requestOptions.timeoutMs ?? options.timeoutMs ?? 10_000;
    const body =
      requestOptions.body === undefined
        ? undefined
        : JSON.stringify(requestOptions.body);

    const fail = (
      info: Pick<HttpClientErrorInfo, 'code' | 'status' | 'attempts'> &
        Partial<Pick<HttpClientErrorInfo, 'problem' | 'cause'>>,
    ): HttpClientError =>
      new HttpClientError({
        client: name,
        method,
        path: url.pathname,
        outcomeUnknown:
          !isRead &&
          (info.code === 'HTTP_TIMEOUT' ||
            info.code === 'HTTP_NETWORK' ||
            info.status >= 500),
        ...info,
      });

    for (let attempt = 1; ; attempt += 1) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = requestOptions.signal
        ? AbortSignal.any([timeout, requestOptions.signal])
        : timeout;

      let response: Response | undefined;
      let failure: HttpClientError;
      try {
        response = await send(url, {
          method,
          signal,
          headers: {
            accept: 'application/json',
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
            ...options.headers?.(),
            ...requestOptions.headers,
            ...(requestOptions.idempotencyKey === undefined
              ? {}
              : { 'idempotency-key': requestOptions.idempotencyKey }),
          },
          ...(body === undefined ? {} : { body }),
        });

        let data: unknown;
        try {
          data = await readBody(response);
        } catch (cause) {
          if (signal.aborted) {
            throw cause;
          }
          throw fail({
            code: 'HTTP_INVALID_RESPONSE',
            status: response.status,
            attempts: attempt,
            cause,
          });
        }

        if (response.status < 400) {
          return {
            status: response.status,
            headers: response.headers,
            data: data as Data,
          };
        }
        failure = fail({
          code: 'HTTP_RESPONSE',
          status: response.status,
          attempts: attempt,
          ...(isProblemDetails(data) ? { problem: data } : {}),
        });
      } catch (cause) {
        if (cause instanceof HttpClientError) {
          throw cause;
        }
        if (requestOptions.signal?.aborted) {
          throw fail({
            code: 'HTTP_ABORTED',
            status: 0,
            attempts: attempt,
            cause,
          });
        }
        failure = fail({
          code: timeout.aborted ? 'HTTP_TIMEOUT' : 'HTTP_NETWORK',
          status: 0,
          attempts: attempt,
          cause,
        });
      }

      const retryable =
        failure.status === 0 || RETRYABLE_STATUSES.includes(failure.status);
      if (!retryable || attempt >= maxAttempts) {
        throw failure;
      }

      const delay = retryAfterMs(response?.headers) ?? backoffMs(attempt);
      logger?.debug('http request failed, retrying', {
        client: name,
        method,
        path: url.pathname,
        attempt,
        status: failure.status,
        code: failure.code,
        delayMs: Math.round(delay),
      });
      await sleep(delay);
    }
  };

  return {
    request,
    get: (path, requestOptions) => request('GET', path, requestOptions),
    post: (path, requestOptions) => request('POST', path, requestOptions),
    put: (path, requestOptions) => request('PUT', path, requestOptions),
    patch: (path, requestOptions) => request('PATCH', path, requestOptions),
    delete: (path, requestOptions) => request('DELETE', path, requestOptions),
  };
};
