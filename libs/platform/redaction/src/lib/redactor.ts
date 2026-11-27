/**
 * Keeps secrets and personal data out of logs and error responses.
 *
 * It works in two ways, and a value is replaced when either applies:
 *
 * 1. By key. A value stored under a key such as `password`, `otp` or `phone`
 *    is replaced whole, whatever it looks like.
 * 2. By shape. Any string is searched for things that look like a secret
 *    wherever they appear, such as a token inside an error message or a
 *    password inside a connection string.
 *
 * Redaction is a safety net, not permission to log carelessly. The rule in
 * CLAUDE.md stands: do not log tokens, OTPs, ID numbers, phone numbers or
 * request bodies in the first place.
 *
 * This file uses no Node API, so it can move to a universal lib if client
 * apps need it.
 */

export const REDACTED = '[REDACTED]';
export const TRUNCATED = '[TRUNCATED]';

/** A shape to look for inside strings. */
export interface RedactionPattern {
  /** For tests and for explaining a redaction: "jwt", "phone". */
  name: string;
  /** Must have the global flag. */
  pattern: RegExp;
  /** What to put in place of a match. Defaults to REDACTED. */
  replace?: (match: string) => string;
}

export interface RedactorOptions {
  /** More keys whose values are replaced whole. Matched like the built-in ones. */
  keys?: readonly string[];
  /**
   * More shapes to look for in strings. Country packs add their own here,
   * such as national ID formats.
   */
  patterns?: readonly RedactionPattern[];
  /** Objects nested deeper than this are replaced with TRUNCATED. Defaults to 8. */
  maxDepth?: number;
}

export interface Redactor {
  /**
   * A redacted copy of any value. The input is never changed. Class
   * instances other than plain objects, arrays, Dates and Errors are turned
   * into what JSON would make of them first.
   */
  redact<Value>(value: Value): Value;
  /** A string with every recognised shape replaced. */
  redactText(text: string): string;
}

/**
 * Keys that mark a secret or personal data. A key matches when, with
 * punctuation removed and in lower case, it equals one of these or ends with
 * one: `access_token`, `X-Api-Key` and `customerPhone` all match, while
 * `tokenCount` and `passwordless` do not.
 */
export const SENSITIVE_KEYS: readonly string[] = [
  // credentials
  'password',
  'passwordhash',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'setcookie',
  'privatekey',
  'signingkey',
  'credential',
  'credentials',
  // one-time codes
  'otp',
  'pin',
  'verificationcode',
  // phone numbers
  'phone',
  'phonenumber',
  'msisdn',
  'mobile',
  'whatsapp',
  // identity documents
  'idnumber',
  'nationalid',
  'passportnumber',
  'emiratesid',
  // payment instruments
  'cardnumber',
  'cvv',
  'iban',
  // request bodies
  'body',
  'rawbody',
  'requestbody',
];

/** True when the digits pass the Luhn check that every payment card number passes. */
const passesLuhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};

/**
 * Shapes recognised in any string. Each is specific enough not to swallow
 * ordinary business data: amounts, quantities and UUIDs pass through.
 */
export const DEFAULT_PATTERNS: readonly RedactionPattern[] = [
  {
    // header.payload.signature, as in an internal or provider token
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  },
  {
    name: 'bearer',
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (match) => `${match.split(/\s+/)[0]} ${REDACTED}`,
  },
  {
    // scheme://user:password@host  ->  scheme://user:[REDACTED]@host
    name: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):[^\s@/]+@/gi,
    replace: (match) =>
      `${match.slice(0, match.indexOf(':', match.indexOf('//')))}:${REDACTED}@`,
  },
  {
    // international format: +237 6 77 12 34 56, +971501234567
    name: 'phone',
    pattern: /\+\d[\d\s().-]{6,18}\d/g,
  },
  {
    // 14 to 19 digits, optionally grouped, that pass the Luhn check. Not 13:
    // a millisecond timestamp has 13 digits, and one in ten passes Luhn.
    name: 'card',
    pattern: /\b\d(?:[ -]?\d){13,18}\b/g,
    replace: (match) =>
      passesLuhn(match.replace(/[ -]/g, '')) ? REDACTED : match,
  },
];

const normalise = (key: string): string =>
  key.toLowerCase().replace(/[^a-z0-9]/g, '');

export const createRedactor = (options: RedactorOptions = {}): Redactor => {
  const keys = [...SENSITIVE_KEYS, ...(options.keys ?? []).map(normalise)];
  const patterns = [...DEFAULT_PATTERNS, ...(options.patterns ?? [])];
  const maxDepth = options.maxDepth ?? 8;

  for (const { name, pattern } of patterns) {
    if (!pattern.global) {
      throw new Error(`Redaction pattern "${name}" must have the global flag.`);
    }
  }

  const isSensitiveKey = (key: string): boolean => {
    const normalised = normalise(key);
    return keys.some(
      (candidate) => normalised === candidate || normalised.endsWith(candidate),
    );
  };

  const redactText = (text: string): string => {
    let result = text;
    for (const { pattern, replace } of patterns) {
      result = result.replace(pattern, replace ?? (() => REDACTED));
    }
    return result;
  };

  const walk = (value: unknown, depth: number, seen: Set<object>): unknown => {
    if (typeof value === 'string') {
      return redactText(value);
    }
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    if (value instanceof Date) {
      return value;
    }
    if (seen.has(value)) {
      return TRUNCATED;
    }
    if (depth >= maxDepth) {
      return TRUNCATED;
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => walk(item, depth + 1, seen));
      }
      if (value instanceof Error) {
        const source = value as Error & Record<string, unknown>;
        // name, message, stack and cause are not enumerable, so they are
        // copied by hand next to the error's own fields (code, details, …).
        return walk(
          {
            name: value.name,
            message: value.message,
            ...(value.stack === undefined ? {} : { stack: value.stack }),
            ...Object.fromEntries(Object.entries(source)),
            ...(value.cause === undefined ? {} : { cause: value.cause }),
          },
          depth,
          seen,
        );
      }
      const withToJson = value as { toJSON?: () => unknown };
      const prototype = Object.getPrototypeOf(value) as object | null;
      const isPlain = prototype === Object.prototype || prototype === null;
      if (!isPlain && typeof withToJson.toJSON === 'function') {
        // Money, Decimal and friends: redact what they serialise to.
        return walk(withToJson.toJSON(), depth, seen);
      }
      const copy: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        copy[key] = isSensitiveKey(key)
          ? entry === undefined || entry === null
            ? entry
            : REDACTED
          : walk(entry, depth + 1, seen);
      }
      return copy;
    } finally {
      seen.delete(value);
    }
  };

  return {
    redact: <Value>(value: Value): Value => walk(value, 0, new Set()) as Value,
    redactText,
  };
};

/** The redactor the logger, the error mapper and the HTTP client use unless given another. */
export const defaultRedactor: Redactor = createRedactor();
