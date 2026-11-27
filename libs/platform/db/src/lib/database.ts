import type { Logger } from '@hk/platform/logger';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export interface DatabaseOptions {
  /** postgres://role:password@host:port/database. Never logged. */
  url: string;
  /** Shows in pg_stat_activity and in log lines: "sales". */
  name: string;
  /** Connections this process may hold. Defaults to 10. */
  maxConnections?: number;
  /** A statement running longer than this is cancelled by the server. Defaults to 30000. */
  statementTimeoutMs?: number;
  logger?: Logger;
}

export type Drizzle = NodePgDatabase<Record<string, never>>;

/** What a transaction callback receives. Has the same query API as the database. */
export type Transaction = Parameters<Parameters<Drizzle['transaction']>[0]>[0];

export interface Database {
  readonly name: string;
  /**
   * The Drizzle handle. Use it through withTenantTransaction or
   * withSystemTransaction, not directly: a query outside a tenant transaction
   * has no tenant set, so row-level security hides every business row.
   */
  readonly drizzle: Drizzle;
  /** Resolves when the server answers. For a readiness check. */
  ping(): Promise<void>;
  /** Waits for checked-out connections to be returned, then closes the pool. */
  close(): Promise<void>;
}

const SCHEMES = ['postgres:', 'postgresql:'];

const assertPostgresUrl = (url: string): void => {
  let protocol: string | undefined;
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol === undefined || !SCHEMES.includes(protocol)) {
    // The URL is not included: it holds a password.
    throw new Error(
      'Database URL must start with postgres:// or postgresql://.',
    );
  }
};

/**
 * Opens the service's connection pool.
 *
 * A service connects as its app role (hk_<service>_app), which owns nothing
 * and is not a superuser, so row-level security applies to everything it does.
 */
export const createDatabase = (options: DatabaseOptions): Database => {
  assertPostgresUrl(options.url);
  const { logger, name } = options;

  const pool = new Pool({
    connectionString: options.url,
    application_name: name,
    max: options.maxConnections ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    // A transaction left open by a bug would hold its connection and its
    // locks forever. The server ends it after a minute idle.
    idle_in_transaction_session_timeout: 60_000,
    connectionTimeoutMillis: 5_000,
  });

  // Without a listener, an error on an idle connection stops the process.
  pool.on('error', (err) => {
    logger?.warn('postgres pool error', { database: name, err });
  });

  return {
    name,
    drizzle: drizzle(pool),
    ping: async () => {
      await pool.query('select 1');
    },
    close: () => pool.end(),
  };
};
