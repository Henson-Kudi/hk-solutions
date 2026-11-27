import type { z } from 'zod';

export interface ConfigIssue {
  /** The environment variable, for example "DATABASE_URL". */
  key: string;
  /** What is wrong with it. Never contains the value. */
  message: string;
}

/**
 * Thrown at start-up when the environment does not match the schema. The
 * message lists every bad variable at once, by name only, so a secret can
 * never end up in a crash log.
 */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration: ${issues
        .map((issue) => `${issue.key} (${issue.message})`)
        .join('; ')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
};

/**
 * Reads and validates configuration once, at start-up.
 *
 * - A variable set to an empty string counts as not set, so `PORT=` falls back
 *   to the schema's default instead of failing or becoming 0.
 * - The result is deeply frozen.
 * - On failure it throws a ConfigError naming every bad variable.
 *
 * A service calls this in its main file and passes the result down. Nothing
 * else reads process.env.
 */
export const loadConfig = <Schema extends z.ZodType>(
  schema: Schema,
  environment: Environment = process.env,
): Readonly<z.output<Schema>> => {
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && value !== '') {
      present[key] = value;
    }
  }

  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        key: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return deepFreeze(parsed.data);
};
