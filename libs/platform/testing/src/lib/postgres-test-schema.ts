import { pgSchema, type PgSchema } from 'drizzle-orm/pg-core';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { Client } from 'pg';

/** The superuser URL integration tests run against, or undefined when none is configured. */
export const postgresTestUrl = (): string | undefined =>
  process.env['HK_TEST_DATABASE_URL'] || undefined;

/** The Redis URL integration tests run against, or undefined when none is configured. */
export const redisTestUrl = (): string | undefined =>
  process.env['HK_TEST_REDIS_URL'] || undefined;

export interface TestSchemaOptions<Tables extends Record<string, unknown>> {
  /** A superuser URL: the helper creates roles. */
  adminUrl: string;
  /** Lower-case letters only. Shows in the schema name, to tell suites apart. */
  prefix: string;
  /** Builds the suite's Drizzle tables in the given schema. */
  define: (schema: PgSchema) => Tables;
}

export interface TestSchema<Tables extends Record<string, unknown>> {
  /** The generated schema name, for example "spec_outbox_m1x2_8f3". */
  name: string;
  tables: Tables;
  /**
   * Connection URL for the app role. Code under test connects with this, the
   * way a service does: the role owns nothing and is not a superuser, so
   * row-level security applies to it.
   */
  appUrl: string;
  /** A superuser connection, for arranging and inspecting state behind the code's back. */
  admin: Client;
  /** Empties the named tables. Call it between tests. */
  truncate(...tableNames: string[]): Promise<void>;
  /** Drops the schema and both roles and closes the admin connection. */
  drop(): Promise<void>;
}

const APP_PASSWORD = 'spec-app-password';

/**
 * Creates a throwaway schema laid out like a real service's:
 *
 * - an owner role that cannot log in and owns the tables;
 * - an app role that can log in and may only read and write rows;
 * - tables created by drizzle-kit from the Drizzle definitions, which is how
 *   real migrations are generated, so the DDL under test is the real DDL.
 *
 * Names are unique per call, so suites can run in parallel on one server.
 */
export const createTestSchema = async <Tables extends Record<string, unknown>>(
  options: TestSchemaOptions<Tables>,
): Promise<TestSchema<Tables>> => {
  if (!/^[a-z]+$/.test(options.prefix)) {
    throw new Error('Test schema prefix must be lower-case letters only.');
  }
  const unique = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const name = `spec_${options.prefix}_${unique}`;
  const owner = `${name}_owner`;
  const app = `${name}_app`;

  const schema = pgSchema(name);
  const tables = options.define(schema);

  const admin = new Client({ connectionString: options.adminUrl });
  await admin.connect();

  // Every identifier below is generated above from [a-z0-9_], never from input.
  await admin.query(`create role ${owner} nologin`);
  await admin.query(`create role ${app} login password '${APP_PASSWORD}'`);
  await admin.query(`create schema ${name} authorization ${owner}`);
  await admin.query(`grant usage on schema ${name} to ${app}`);
  await admin.query(
    `alter default privileges for role ${owner} in schema ${name}
       grant select, insert, update, delete on tables to ${app}`,
  );

  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ schema, ...tables }),
  );
  await admin.query(`set role ${owner}`);
  for (const statement of statements) {
    if (!/^create schema/i.test(statement.trim())) {
      await admin.query(statement);
    }
  }
  await admin.query('reset role');

  const appUrl = new URL(options.adminUrl);
  appUrl.username = app;
  appUrl.password = APP_PASSWORD;

  return {
    name,
    tables,
    appUrl: appUrl.toString(),
    admin,
    truncate: async (...tableNames) => {
      for (const tableName of tableNames) {
        if (!/^[a-z_]+$/.test(tableName)) {
          throw new Error(
            'Table name must be lower-case letters and underscores.',
          );
        }
        await admin.query(`truncate ${name}.${tableName}`);
      }
    },
    drop: async () => {
      await admin.query(`drop schema if exists ${name} cascade`);
      await admin.query(`drop owned by ${owner}`);
      await admin.query(`drop role if exists ${app}`);
      await admin.query(`drop role if exists ${owner}`);
      await admin.end();
    },
  };
};

/** A promise with its resolve and reject exposed, for holding a handler open in a test. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Waits until `condition` is true, checking every 20 ms. Throws after `timeoutMs`. */
export const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Condition was not met in time.');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
