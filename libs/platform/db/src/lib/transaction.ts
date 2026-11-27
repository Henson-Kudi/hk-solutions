import { AsyncLocalStorage } from 'node:async_hooks';
import { DomainError } from '@hk/platform/universal';
import { sql } from 'drizzle-orm';
import { BUSINESS_SETTING, TENANT_SETTING } from './columns';
import type { Database, Transaction } from './database';
import { requireTenantContext } from './tenant-context';

interface ActiveTransaction {
  database: Database;
  transaction: Transaction;
  /** tenant: the tenant settings are set. system: they are not, so RLS hides business rows. */
  kind: 'tenant' | 'system';
}

const storage = new AsyncLocalStorage<ActiveTransaction>();

export interface TransactionOptions {
  /** Defaults to the server's default, read committed. */
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  /** The server rejects any write. Use for reports. */
  readOnly?: boolean;
}

const invariant = (code: string, message: string): DomainError =>
  new DomainError(code, message, { kind: 'invariant' });

const configOf = (options: TransactionOptions) => ({
  ...(options.isolationLevel === undefined
    ? {}
    : { isolationLevel: options.isolationLevel }),
  ...(options.readOnly ? { accessMode: 'read only' as const } : {}),
});

const join = <T>(
  active: ActiveTransaction,
  database: Database,
  kind: ActiveTransaction['kind'],
  action: (transaction: Transaction) => Promise<T>,
): Promise<T> => {
  if (active.database !== database) {
    throw invariant(
      'TRANSACTION_DATABASE_MISMATCH',
      'A transaction on another database is already open.',
    );
  }
  if (active.kind !== kind) {
    throw invariant(
      'TRANSACTION_KIND_MISMATCH',
      'A tenant transaction and a system transaction cannot be nested in each other.',
    );
  }
  return action(active.transaction);
};

/**
 * Runs `action` in a database transaction for the business in the tenant
 * context. Throws when there is no tenant context.
 *
 * The transaction starts by setting app.tenant_id and app.business_id for its
 * own duration (the effect of SET LOCAL). Row-level security policies compare
 * every row against those two settings, so inside this transaction the
 * database itself refuses to show or accept another business's rows, whatever
 * the SQL says. When the transaction ends the settings are gone, so a pooled
 * connection never carries a tenant over to its next user.
 *
 * Calling it again inside `action` joins the open transaction: everything
 * commits or rolls back together. That is how an outbox row is written in the
 * same transaction as the change it announces.
 *
 * Do not call a payment provider or any other remote service inside `action`.
 * A transaction holds a connection and locks for as long as it is open.
 */
export const withTenantTransaction = async <T>(
  database: Database,
  action: (transaction: Transaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> => {
  const context = requireTenantContext();
  const active = storage.getStore();
  if (active) {
    return join(active, database, 'tenant', action);
  }
  return database.drizzle.transaction(async (transaction) => {
    // set_config(name, value, true) is SET LOCAL with bind parameters.
    await transaction.execute(
      sql`select set_config(${TENANT_SETTING}, ${context.tenantId}, true), set_config(${BUSINESS_SETTING}, ${context.businessId}, true)`,
    );
    return storage.run({ database, transaction, kind: 'tenant' }, () =>
      action(transaction),
    );
  }, configOf(options));
};

/**
 * Runs `action` in a transaction with no tenant set, for work that is not
 * about one business: looking up a user at login, relaying outbox rows,
 * reading reference tables.
 *
 * Tables protected by the tenant policy show no rows here and accept none.
 * A ScopedRepository refuses to run in it.
 */
export const withSystemTransaction = async <T>(
  database: Database,
  action: (transaction: Transaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> => {
  const active = storage.getStore();
  if (active) {
    return join(active, database, 'system', action);
  }
  return database.drizzle.transaction(
    (transaction) =>
      storage.run({ database, transaction, kind: 'system' }, () =>
        action(transaction),
      ),
    configOf(options),
  );
};

/** The open tenant transaction. Throws when there is none. Repositories use this. */
export const requireTenantTransaction = (): Transaction => {
  const active = storage.getStore();
  if (!active) {
    throw invariant(
      'TRANSACTION_MISSING',
      'This query must run inside withTenantTransaction.',
    );
  }
  if (active.kind !== 'tenant') {
    throw invariant(
      'TRANSACTION_NOT_TENANT',
      'Tenant data cannot be accessed from a system transaction.',
    );
  }
  return active.transaction;
};

/** The open system transaction. Throws when there is none. */
export const requireSystemTransaction = (): Transaction => {
  const active = storage.getStore();
  if (!active || active.kind !== 'system') {
    throw invariant(
      'TRANSACTION_MISSING',
      'This query must run inside withSystemTransaction.',
    );
  }
  return active.transaction;
};

/** True inside withTenantTransaction or withSystemTransaction. */
export const isInTransaction = (): boolean => storage.getStore() !== undefined;
