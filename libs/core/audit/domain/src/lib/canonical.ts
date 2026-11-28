import { DomainError } from '@hk/platform/universal';

/**
 * Canonical JSON: one text form for a value, whatever order its keys were
 * written in.
 *
 * A hash is taken over text. If the same event could be written as two
 * different texts, it would have two different hashes, and a chain checked
 * on another machine (or after a round trip through a database that reorders
 * keys) would look broken. So keys are sorted and there is no whitespace.
 *
 * Only plain data is allowed: null, booleans, strings, whole numbers, arrays
 * and plain objects. Fractions are refused because 0.1 does not survive every
 * store unchanged; money and other decimals travel as strings.
 */

export const AUDIT_ERRORS = {
  /** A value that has no canonical form: a function, a Date, a fraction, undefined. */
  DETAILS_INVALID: 'AUDIT_DETAILS_INVALID',
  /** The details are nested too deeply or are too large. */
  DETAILS_TOO_LARGE: 'AUDIT_DETAILS_TOO_LARGE',
  EVENT_INVALID: 'AUDIT_EVENT_INVALID',
  /** A store was asked to work outside the scope it was given. */
  SCOPE_MISMATCH: 'AUDIT_SCOPE_MISMATCH',
} as const;

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

export type JsonObject = { readonly [key: string]: Json };

const MAX_DEPTH = 8;

const invalid = (why: string): DomainError =>
  new DomainError(
    AUDIT_ERRORS.DETAILS_INVALID,
    `Audit details must be plain data: ${why}.`,
  );

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const write = (value: unknown, depth: number): string => {
  if (depth > MAX_DEPTH) {
    throw new DomainError(
      AUDIT_ERRORS.DETAILS_TOO_LARGE,
      `Audit details may be nested at most ${MAX_DEPTH} levels deep.`,
    );
  }
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw invalid(
          'a number must be a whole number; write decimals as strings',
        );
      }
      return String(value);
    case 'object':
      break;
    default:
      throw invalid(`a ${typeof value} is not allowed`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => write(item, depth + 1)).join(',')}]`;
  }
  if (!isPlainObject(value)) {
    throw invalid('only plain objects and arrays are allowed');
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) {
        throw invalid(`"${key}" is undefined; leave the key out or use null`);
      }
      return `${JSON.stringify(key)}:${write(item, depth + 1)}`;
    });
  return `{${entries.join(',')}}`;
};

/** The canonical text of a value. Throws a DomainError when it has none. */
export const canonicalJson = (value: unknown): string => write(value, 0);
