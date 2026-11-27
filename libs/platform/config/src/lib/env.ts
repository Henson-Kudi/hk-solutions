import { z } from 'zod';

/**
 * Schema pieces for environment variables. Every value arrives as a string, so
 * each piece parses strictly and says what it expected, without echoing what
 * it received.
 */

const DURATION = /^(\d+)(ms|s|m|h|d)$/;
const DURATION_UNITS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

/** A whole number such as "5432". Rejects "5.5", "1e3" and " 5". */
const integer = (
  options: { min?: number; max?: number } = {},
): z.ZodType<number, string> => {
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return z
    .string()
    .regex(/^-?\d+$/, 'must be a whole number')
    .transform(Number)
    .refine((value) => Number.isSafeInteger(value), 'is too large')
    .refine((value) => value >= min, `must be at least ${min}`)
    .refine((value) => value <= max, `must be at most ${max}`);
};

/** A TCP port, 1 to 65535. */
const port = (): z.ZodType<number, string> => integer({ min: 1, max: 65_535 });

/** "true", "false", "1" or "0". */
const boolean = (): z.ZodType<boolean, string> =>
  z
    .enum(['true', 'false', '1', '0'], 'must be true, false, 1 or 0')
    .transform((value) => value === 'true' || value === '1');

/** An absolute URL. Pass the schemes you accept, for example ["postgres:", "postgresql:"]. */
const url = (protocols?: readonly string[]): z.ZodType<string, string> =>
  z.string().refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return protocols ? protocols.includes(parsed.protocol) : true;
      } catch {
        return false;
      }
    },
    protocols
      ? `must be a URL starting with ${protocols.join(' or ')}`
      : 'must be a URL',
  );

/** A duration such as "250ms", "30s", "5m", "1h" or "7d", returned in milliseconds. */
const duration = (): z.ZodType<number, string> =>
  z
    .string()
    .regex(DURATION, 'must be a duration such as 250ms, 30s, 5m, 1h or 7d')
    .transform((value) => {
      const [, amount, unit] = DURATION.exec(value) as RegExpExecArray;
      return (
        Number(amount) * DURATION_UNITS[unit as keyof typeof DURATION_UNITS]
      );
    });

/** A comma-separated list such as "core,sales". Items are trimmed and empty ones dropped. */
const list = (): z.ZodType<string[], string> =>
  z.string().transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

/** A string that must not be empty. For secrets and identifiers. */
const text = (): z.ZodType<string, string> =>
  z.string().min(1, 'must not be empty');

export const env = { integer, port, boolean, url, duration, list, text };

export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

/**
 * Variables every service reads. Spread it into the service's own schema:
 *
 *   const schema = z.object({ ...serviceEnv, DATABASE_URL: env.url(['postgres:']) });
 */
export const serviceEnv = {
  NODE_ENV: z
    .enum(NODE_ENVIRONMENTS, 'must be development, test or production')
    .default('development'),
  LOG_LEVEL: z
    .enum(LOG_LEVELS, `must be one of ${LOG_LEVELS.join(', ')}`)
    .default('info'),
  PORT: port().default(3000),
  /** Where traces are sent. Tracing is off when this is not set. */
  OTEL_EXPORTER_OTLP_ENDPOINT: url(['http:', 'https:']).optional(),
};
