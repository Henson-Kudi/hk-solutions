import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';
import { getLogContext, type LogFields } from './log-context';

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The logging interface the whole platform codes against.
 *
 * `message` is a constant string and values go in `fields`. That is what makes
 * logs searchable and lets redaction see every value:
 *
 *   logger.info('invoice issued', { invoiceId });      // yes
 *   logger.info(`invoice ${invoiceId} issued`);        // rejected by lint
 */
export interface Logger {
  fatal(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  trace(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
  isLevelEnabled(level: LogLevel): boolean;
}

export interface LoggerOptions {
  /** The service name, on every line. */
  service: string;
  level?: LogLevel;
  version?: string;
  environment?: string;
  /** Where lines are written. Defaults to stdout. */
  destination?: DestinationStream;
  /**
   * Called for the fields of every line before it is written.
   * platform/redaction plugs in here. It runs in addition to the built-in
   * key-based redaction below, not instead of it.
   */
  redact?: (fields: LogFields) => LogFields;
  /** Fields added to every line. Defaults to the current log context. */
  context?: () => LogFields | undefined;
}

export const REDACTED = '[REDACTED]';

/**
 * Keys whose value is never written, wherever they appear in the first three
 * levels of the fields. This is a safety net for the obvious cases; pattern
 * based redaction of values is platform/redaction's job.
 */
export const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'pin',
  'otp',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'secret',
  'clientSecret',
  'apiKey',
  'authorization',
  'cookie',
  'set-cookie',
] as const;

const redactPaths = SENSITIVE_KEYS.flatMap((key) => {
  const name = /^[a-zA-Z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
  const child = name.startsWith('[') ? name : `.${name}`;
  return [name, `*${child}`, `*.*${child}`];
});

const MAX_CAUSE_DEPTH = 3;

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: unknown;
  kind?: unknown;
  status?: unknown;
  details?: unknown;
  cause?: unknown;
}

/** An Error as plain data, including a DomainError's code and a short cause chain. */
export const serializeError = (error: Error, depth = 0): SerializedError => {
  const source = error as Error & Record<string, unknown>;
  const serialized: SerializedError = {
    name: error.name,
    message: error.message,
  };
  if (error.stack !== undefined) serialized.stack = error.stack;
  for (const key of ['code', 'kind', 'status', 'details'] as const) {
    if (source[key] !== undefined) serialized[key] = source[key];
  }
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    serialized.cause =
      error.cause instanceof Error
        ? serializeError(error.cause, depth + 1)
        : error.cause;
  }
  return serialized;
};

const prepare = (
  fields: LogFields | undefined,
  redact: LoggerOptions['redact'],
): LogFields => {
  if (!fields) {
    return {};
  }
  const prepared: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    prepared[key] = value instanceof Error ? serializeError(value) : value;
  }
  return redact ? redact(prepared) : prepared;
};

const wrap = (
  instance: PinoLogger,
  redact: LoggerOptions['redact'],
): Logger => {
  const write =
    (level: Exclude<LogLevel, 'silent'>) =>
    (message: string, fields?: LogFields): void => {
      if (instance.isLevelEnabled(level)) {
        instance[level](prepare(fields, redact), message);
      }
    };
  return {
    fatal: write('fatal'),
    error: write('error'),
    warn: write('warn'),
    info: write('info'),
    debug: write('debug'),
    trace: write('trace'),
    child: (fields) => wrap(instance.child(prepare(fields, redact)), redact),
    isLevelEnabled: (level) =>
      level !== 'silent' && instance.isLevelEnabled(level),
  };
};

/**
 * Creates the service's logger. Lines are JSON, one per line:
 *
 *   {"level":"info","time":"2026-11-27T10:00:00.000Z","service":"sales","message":"invoice issued","invoiceId":"…"}
 */
export const createLogger = (options: LoggerOptions): Logger => {
  const context = options.context ?? getLogContext;
  const instance = pino(
    {
      level: options.level ?? 'info',
      messageKey: 'message',
      timestamp: pino.stdTimeFunctions.isoTime,
      base: {
        service: options.service,
        ...(options.version === undefined ? {} : { version: options.version }),
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
      },
      formatters: {
        level: (label) => ({ level: label }),
      },
      // Errors are already plain data by the time pino sees them (see
      // prepare), so pino's own serializer for the `err` key is switched off.
      serializers: { err: (value: unknown) => value },
      mixin: () => prepare(context(), options.redact),
      redact: { paths: redactPaths, censor: REDACTED },
    },
    options.destination ?? pino.destination({ sync: false }),
  );
  return wrap(instance, options.redact);
};
