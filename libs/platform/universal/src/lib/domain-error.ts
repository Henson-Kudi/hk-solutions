/**
 * How a caller should treat the failure. platform/errors maps this to an HTTP
 * status on the server; clients use it to pick a message style.
 */
export type DomainErrorKind =
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'forbidden'
  | 'invariant';

/** Small, flat and serialisable. Never put tokens, OTPs, ID numbers or phone numbers here. */
export type DomainErrorDetails = Readonly<
  Record<string, string | number | boolean | null>
>;

export interface DomainErrorOptions {
  /** Defaults to 'validation'. */
  kind?: DomainErrorKind;
  details?: DomainErrorDetails;
  cause?: unknown;
}

export interface DomainErrorJson {
  code: string;
  kind: DomainErrorKind;
  message: string;
  details: DomainErrorDetails;
}

/**
 * A business rule said no.
 *
 * `code` is a stable UPPER_SNAKE identifier. It is the i18n key for the text
 * shown to users and the value clients branch on, so it never changes once
 * released. `message` is a constant English sentence for developers and logs;
 * variable values go in `details`.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly kind: DomainErrorKind;
  readonly details: DomainErrorDetails;

  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.kind = options.kind ?? 'validation';
    this.details = Object.freeze({ ...options.details });
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  toJSON(): DomainErrorJson {
    return {
      code: this.code,
      kind: this.kind,
      message: this.message,
      details: this.details,
    };
  }
}

export const isDomainError = (value: unknown): value is DomainError =>
  value instanceof DomainError;
