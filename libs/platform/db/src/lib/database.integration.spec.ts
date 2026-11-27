import { DomainError, createUuidV7Generator } from '@hk/platform/universal';
import { eq, sql } from 'drizzle-orm';
import { pgSchema, text } from 'drizzle-orm/pg-core';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { Client } from 'pg';
import { branchColumn, tenantColumns, tenantIsolation } from './columns';
import { createDatabase, type Database } from './database';
import { findTenantCatalogViolations } from './schema-check';
import {
  ScopedRepository,
  type NewRow,
  type Row,
  type RowPatch,
} from './scoped-repository';
import { runWithTenantContext, type TenantContext } from './tenant-context';
import { withSystemTransaction, withTenantTransaction } from './transaction';

/**
 * These tests need a real PostgreSQL and a superuser URL, because they create
 * roles. They run when HK_TEST_DATABASE_URL is set:
 *
 *   pnpm infra:up
 *   HK_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54320/hk pnpm nx test platform-db
 *
 * The layout mirrors production: the schema belongs to an owner role that
 * cannot log in, and the code under test connects as a separate app role that
 * is neither the owner nor a superuser. Row-level security only applies to
 * such a role, so testing as the superuser would prove nothing.
 */
const adminUrl = process.env['HK_TEST_DATABASE_URL'];
const describeWithPostgres = adminUrl ? describe : describe.skip;

describe('test setup', () => {
  it('has a PostgreSQL to test against when running in CI', () => {
    if (process.env['CI']) {
      expect(adminUrl).toBeDefined();
    }
  });
});

const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
const SCHEMA = `spec_${suffix}`;
const OWNER = `${SCHEMA}_owner`;
const APP = `${SCHEMA}_app`;
const APP_PASSWORD = 'spec-app-password';

const spec = pgSchema(SCHEMA);

const notes = spec.table(
  'notes',
  { ...tenantColumns, ...branchColumn, body: text('body').notNull() },
  (table) => [...tenantIsolation('notes', table)],
);

/** A reference table: no tenant columns, no row-level security. */
const countries = spec.table('countries', { code: text('code').primaryKey() });

class NotesRepository extends ScopedRepository<typeof notes> {
  constructor() {
    super(notes);
  }
  add(values: NewRow<typeof notes>) {
    return this.insert(values);
  }
  get(id: string) {
    return this.findById(id);
  }
  all() {
    return this.find();
  }
  withBody(body: string) {
    return this.find(eq(notes.body, body));
  }
  change(id: string, version: number, patch: RowPatch<typeof notes>) {
    return this.update(id, version, patch);
  }
  remove(id: string) {
    return this.delete(id);
  }
}

const nextId = createUuidV7Generator();

const TENANT_1 = nextId();
const TENANT_2 = nextId();
const BUSINESS_A: TenantContext = { tenantId: TENANT_1, businessId: nextId() };
const BUSINESS_B: TenantContext = { tenantId: TENANT_1, businessId: nextId() };
const OTHER_TENANT: TenantContext = {
  tenantId: TENANT_2,
  businessId: nextId(),
};

const codeOf = async (action: () => Promise<unknown>): Promise<string> => {
  try {
    await action();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'NOT_A_DOMAIN_ERROR';
  }
  return 'DID_NOT_THROW';
};

/** The PostgreSQL error code of a failed statement, wherever the driver put it. */
const sqlStateOf = async (action: () => Promise<unknown>): Promise<string> => {
  try {
    await action();
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error) {
      const state = (current as { code?: unknown }).code;
      if (typeof state === 'string' && /^[0-9A-Z]{5}$/.test(state)) {
        return state;
      }
      current = current.cause;
    }
    return 'NO_SQLSTATE';
  }
  return 'DID_NOT_THROW';
};

const ROW_LEVEL_SECURITY_VIOLATION = '42501';
const READ_ONLY_TRANSACTION = '25006';

describeWithPostgres('against a real PostgreSQL', () => {
  let admin: Client;
  let database: Database;
  const repository = new NotesRepository();

  const as = <T>(
    context: TenantContext,
    action: () => Promise<T>,
  ): Promise<T> =>
    runWithTenantContext(context, () =>
      withTenantTransaction(database, action),
    );

  const addNote = (
    context: TenantContext,
    body: string,
  ): Promise<Row<typeof notes>> =>
    as(context, () => repository.add({ id: nextId(), body }));

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();

    await admin.query(`create role ${OWNER} nologin`);
    await admin.query(`create role ${APP} login password '${APP_PASSWORD}'`);
    await admin.query(`create schema ${SCHEMA} authorization ${OWNER}`);
    await admin.query(`grant usage on schema ${SCHEMA} to ${APP}`);
    await admin.query(
      `alter default privileges for role ${OWNER} in schema ${SCHEMA}
         grant select, insert, update, delete on tables to ${APP}`,
    );

    // The tables are created from the Drizzle definitions by drizzle-kit, the
    // same way a real migration is generated. So what is tested is the DDL
    // that tenantIsolation() actually produces.
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson({ spec, notes, countries }),
    );
    await admin.query(`set role ${OWNER}`);
    for (const statement of statements) {
      if (!/^create schema/i.test(statement.trim())) {
        await admin.query(statement);
      }
    }
    await admin.query('reset role');

    const appUrl = new URL(adminUrl as string);
    appUrl.username = APP;
    appUrl.password = APP_PASSWORD;
    database = createDatabase({
      url: appUrl.toString(),
      name: 'platform-db-spec',
      maxConnections: 2,
    });
  }, 60_000);

  afterAll(async () => {
    await database?.close();
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.query(`drop owned by ${OWNER}`);
    await admin.query(`drop role if exists ${APP}`);
    await admin.query(`drop role if exists ${OWNER}`);
    await admin.end();
  });

  afterEach(async () => {
    await admin.query(`truncate ${SCHEMA}.notes`);
  });

  describe('the test itself', () => {
    it('connects as a role that row-level security applies to', async () => {
      const result = await database.drizzle.execute<{
        role: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        owns_table: boolean;
      }>(sql`
        select current_user as role, r.rolsuper, r.rolbypassrls,
               (select tableowner = current_user from pg_tables
                 where schemaname = ${SCHEMA} and tablename = 'notes') as owns_table
        from pg_roles r where r.rolname = current_user`);
      expect(result.rows[0]).toEqual({
        role: APP,
        rolsuper: false,
        rolbypassrls: false,
        owns_table: false,
      });
    });

    it('created the table with row-level security on', async () => {
      const result = await admin.query(
        `select relrowsecurity from pg_class where oid = '${SCHEMA}.notes'::regclass`,
      );
      expect(result.rows[0]).toEqual({ relrowsecurity: true });
    });
  });

  describe('a query without context throws', () => {
    it('throws without a tenant context', async () => {
      expect(await codeOf(() => repository.get(nextId()))).toBe(
        'TENANT_CONTEXT_MISSING',
      );
      expect(
        await codeOf(() => withTenantTransaction(database, async () => 1)),
      ).toBe('TENANT_CONTEXT_MISSING');
    });

    it('throws with a tenant context but outside a transaction', async () => {
      await runWithTenantContext(BUSINESS_A, async () => {
        expect(await codeOf(() => repository.all())).toBe(
          'TRANSACTION_MISSING',
        );
        expect(
          await codeOf(() => repository.add({ id: nextId(), body: 'x' })),
        ).toBe('TRANSACTION_MISSING');
      });
    });

    it('throws inside a system transaction', async () => {
      await runWithTenantContext(BUSINESS_A, () =>
        withSystemTransaction(database, async () => {
          expect(await codeOf(() => repository.all())).toBe(
            'TRANSACTION_NOT_TENANT',
          );
        }),
      );
    });
  });

  describe('ScopedRepository', () => {
    it('stamps tenant, business, user and version on insert', async () => {
      const user = nextId();
      const id = nextId();
      const row = await as({ ...BUSINESS_A, userId: user }, () =>
        repository.add({ id, body: 'hello' }),
      );
      expect(row).toMatchObject({
        id,
        tenantId: BUSINESS_A.tenantId,
        businessId: BUSINESS_A.businessId,
        createdBy: user,
        version: 1,
        branchId: null,
        body: 'hello',
      });
      expect(row.createdAt).toBeInstanceOf(Date);
    });

    it('ignores tenant columns a caller smuggles into an insert', async () => {
      const smuggled = {
        id: nextId(),
        body: 'x',
        tenantId: OTHER_TENANT.tenantId,
        businessId: BUSINESS_B.businessId,
        version: 99,
      } as NewRow<typeof notes>;
      const row = await as(BUSINESS_A, () => repository.add(smuggled));
      expect(row).toMatchObject({
        tenantId: BUSINESS_A.tenantId,
        businessId: BUSINESS_A.businessId,
        version: 1,
      });
    });

    it('finds only the rows of the current business', async () => {
      const mine = await addNote(BUSINESS_A, 'shared text');
      const theirs = await addNote(BUSINESS_B, 'shared text');

      await as(BUSINESS_A, async () => {
        expect(await repository.get(mine.id)).toMatchObject({ id: mine.id });
        expect(await repository.get(theirs.id)).toBeUndefined();
        expect((await repository.all()).map((row) => row.id)).toEqual([
          mine.id,
        ]);
        expect(
          (await repository.withBody('shared text')).map((row) => row.id),
        ).toEqual([mine.id]);
      });
    });

    it('updates at the expected version and moves to the next', async () => {
      const row = await addNote(BUSINESS_A, 'v1');
      const updated = await as(BUSINESS_A, () =>
        repository.change(row.id, 1, { body: 'v2' }),
      );
      expect(updated).toMatchObject({ body: 'v2', version: 2 });
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
        row.updatedAt.getTime(),
      );
    });

    it('rejects an update from a stale version', async () => {
      const row = await addNote(BUSINESS_A, 'v1');
      await as(BUSINESS_A, () => repository.change(row.id, 1, { body: 'v2' }));
      try {
        await as(BUSINESS_A, () =>
          repository.change(row.id, 1, { body: 'lost update' }),
        );
        throw new Error('did not throw');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'ROW_STALE_VERSION',
          kind: 'conflict',
          details: { expectedVersion: 1, currentVersion: 2 },
        });
      }
      await as(BUSINESS_A, async () => {
        expect(await repository.get(row.id)).toMatchObject({ body: 'v2' });
      });
    });

    it('cannot update, delete or move a row of another business', async () => {
      const theirs = await addNote(BUSINESS_B, 'theirs');

      expect(
        await codeOf(() =>
          as(BUSINESS_A, () => repository.change(theirs.id, 1, { body: 'x' })),
        ),
      ).toBe('ROW_NOT_FOUND');
      expect(await as(BUSINESS_A, () => repository.remove(theirs.id))).toBe(
        false,
      );

      const mine = await addNote(BUSINESS_A, 'mine');
      const moved = await as(BUSINESS_A, () =>
        repository.change(mine.id, 1, {
          body: 'still mine',
          businessId: BUSINESS_B.businessId,
        } as RowPatch<typeof notes>),
      );
      expect(moved.businessId).toBe(BUSINESS_A.businessId);

      await as(BUSINESS_B, async () => {
        expect(await repository.get(theirs.id)).toMatchObject({
          body: 'theirs',
          version: 1,
        });
      });
    });

    it('deletes a row of the current business', async () => {
      const row = await addNote(BUSINESS_A, 'bye');
      expect(await as(BUSINESS_A, () => repository.remove(row.id))).toBe(true);
      expect(await as(BUSINESS_A, () => repository.remove(row.id))).toBe(false);
    });
  });

  describe('a row from another business is invisible even with a raw query', () => {
    let rowOfA: Row<typeof notes>;

    beforeEach(async () => {
      rowOfA = await addNote(BUSINESS_A, 'secret of A');
    });

    it.each([
      ['another business of the same tenant', BUSINESS_B],
      ['another tenant', OTHER_TENANT],
    ])('hides it from %s', async (_label, intruder) => {
      await as(intruder, async () => {
        const transaction = await withTenantTransaction(
          database,
          async (tx) => tx,
        );

        const everything = await transaction.execute(
          sql`select * from ${notes}`,
        );
        expect(everything.rows).toEqual([]);

        const byId = await transaction.execute(
          sql`select * from ${notes} where id = ${rowOfA.id}`,
        );
        expect(byId.rows).toEqual([]);

        const byBusiness = await transaction.execute(
          sql`select * from ${notes} where business_id = ${BUSINESS_A.businessId}`,
        );
        expect(byBusiness.rows).toEqual([]);

        const count = await transaction.execute<{ n: string }>(
          sql`select count(*) as n from ${notes}`,
        );
        expect(count.rows[0]?.n).toBe('0');
      });
    });

    it('lets a raw UPDATE or DELETE touch nothing', async () => {
      await as(BUSINESS_B, () =>
        withTenantTransaction(database, async (transaction) => {
          const updated = await transaction.execute(
            sql`update ${notes} set body = 'defaced' where id = ${rowOfA.id}`,
          );
          expect(updated.rowCount).toBe(0);

          const deleted = await transaction.execute(sql`delete from ${notes}`);
          expect(deleted.rowCount).toBe(0);
        }),
      );
      await as(BUSINESS_A, async () => {
        expect(await repository.get(rowOfA.id)).toMatchObject({
          body: 'secret of A',
        });
      });
    });

    it('rejects a raw INSERT for another business', async () => {
      const state = await sqlStateOf(() =>
        as(BUSINESS_B, () =>
          withTenantTransaction(database, (transaction) =>
            transaction.execute(sql`
              insert into ${notes} (id, tenant_id, business_id, body)
              values (${nextId()}, ${BUSINESS_A.tenantId}, ${BUSINESS_A.businessId}, 'planted')`),
          ),
        ),
      );
      expect(state).toBe(ROW_LEVEL_SECURITY_VIOLATION);
    });

    it('rejects a raw UPDATE that moves a row to another business', async () => {
      const mine = await addNote(BUSINESS_B, 'mine');
      const state = await sqlStateOf(() =>
        as(BUSINESS_B, () =>
          withTenantTransaction(database, (transaction) =>
            transaction.execute(sql`
              update ${notes} set business_id = ${BUSINESS_A.businessId}
              where id = ${mine.id}`),
          ),
        ),
      );
      expect(state).toBe(ROW_LEVEL_SECURITY_VIOLATION);
    });

    it('shows and accepts nothing in a system transaction', async () => {
      await withSystemTransaction(database, async (transaction) => {
        const rows = await transaction.execute(sql`select * from ${notes}`);
        expect(rows.rows).toEqual([]);
      });
      const state = await sqlStateOf(() =>
        withSystemTransaction(database, (transaction) =>
          transaction.execute(sql`
            insert into ${notes} (id, tenant_id, business_id, body)
            values (${nextId()}, ${BUSINESS_A.tenantId}, ${BUSINESS_A.businessId}, 'x')`),
        ),
      );
      expect(state).toBe(ROW_LEVEL_SECURITY_VIOLATION);
    });

    it('shows nothing to a query outside any transaction', async () => {
      const rows = await database.drizzle.execute(sql`select * from ${notes}`);
      expect(rows.rows).toEqual([]);
    });

    it('does not leave the tenant on a pooled connection', async () => {
      const single = createDatabase({
        url: (() => {
          const url = new URL(adminUrl as string);
          url.username = APP;
          url.password = APP_PASSWORD;
          return url.toString();
        })(),
        name: 'platform-db-spec-single',
        maxConnections: 1,
      });
      try {
        await runWithTenantContext(BUSINESS_A, () =>
          withTenantTransaction(single, async (transaction) => {
            const during = await transaction.execute<{ business: string }>(
              sql`select current_setting('app.business_id', true) as business`,
            );
            expect(during.rows[0]?.business).toBe(BUSINESS_A.businessId);
          }),
        );
        // Same connection, next user: the setting is gone and so are the rows.
        const after = await single.drizzle.execute<{ business: string | null }>(
          sql`select nullif(current_setting('app.business_id', true), '') as business`,
        );
        expect(after.rows[0]?.business).toBeNull();
        const rows = await single.drizzle.execute(sql`select * from ${notes}`);
        expect(rows.rows).toEqual([]);
      } finally {
        await single.close();
      }
    });
  });

  describe('transactions', () => {
    it('rolls everything back when the action throws', async () => {
      const failure = new Error('use case failed');
      await expect(
        as(BUSINESS_A, async () => {
          await repository.add({ id: nextId(), body: 'never saved' });
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await as(BUSINESS_A, () => repository.all())).toEqual([]);
    });

    it('joins a nested call into the same transaction', async () => {
      await expect(
        as(BUSINESS_A, async () => {
          await repository.add({ id: nextId(), body: 'outer' });
          await withTenantTransaction(database, () =>
            repository.add({ id: nextId(), body: 'inner, like an outbox row' }),
          );
          throw new Error('fail after both writes');
        }),
      ).rejects.toThrow('fail after both writes');
      expect(await as(BUSINESS_A, () => repository.all())).toEqual([]);

      await as(BUSINESS_A, async () => {
        await repository.add({ id: nextId(), body: 'outer' });
        await withTenantTransaction(database, () =>
          repository.add({ id: nextId(), body: 'inner' }),
        );
      });
      expect(await as(BUSINESS_A, () => repository.all())).toHaveLength(2);
    });

    it('refuses to nest a system transaction in a tenant one, or the reverse', async () => {
      expect(
        await codeOf(() =>
          as(BUSINESS_A, () => withSystemTransaction(database, async () => 1)),
        ),
      ).toBe('TRANSACTION_KIND_MISMATCH');
      expect(
        await codeOf(() =>
          runWithTenantContext(BUSINESS_A, () =>
            withSystemTransaction(database, () =>
              withTenantTransaction(database, async () => 1),
            ),
          ),
        ),
      ).toBe('TRANSACTION_KIND_MISMATCH');
    });

    it('rejects a write in a read-only transaction', async () => {
      const state = await sqlStateOf(() =>
        runWithTenantContext(BUSINESS_A, () =>
          withTenantTransaction(
            database,
            () => repository.add({ id: nextId(), body: 'x' }),
            { readOnly: true },
          ),
        ),
      );
      expect(state).toBe(READ_ONLY_TRANSACTION);
    });

    it('keeps concurrent businesses apart on a shared pool', async () => {
      const writes = Array.from({ length: 12 }, (_, index) => {
        const context = index % 2 === 0 ? BUSINESS_A : BUSINESS_B;
        return addNote(context, `note ${index}`);
      });
      const rows = await Promise.all(writes);
      rows.forEach((row, index) => {
        expect(row.businessId).toBe(
          (index % 2 === 0 ? BUSINESS_A : BUSINESS_B).businessId,
        );
      });
      expect(await as(BUSINESS_A, () => repository.all())).toHaveLength(6);
      expect(await as(BUSINESS_B, () => repository.all())).toHaveLength(6);
    });
  });

  describe('findTenantCatalogViolations', () => {
    const check = (exempt: string[] = []) =>
      withSystemTransaction(database, (transaction) =>
        findTenantCatalogViolations(transaction, SCHEMA, { exempt }),
      );

    it('accepts the protected table and reports the unprotected one', async () => {
      expect(await check()).toEqual([
        {
          table: `${SCHEMA}.countries`,
          problem: 'has no NOT NULL tenant_id column',
        },
        {
          table: `${SCHEMA}.countries`,
          problem: 'has no NOT NULL business_id column',
        },
        {
          table: `${SCHEMA}.countries`,
          problem: 'does not have row-level security enabled',
        },
        {
          table: `${SCHEMA}.countries`,
          problem: 'has no tenant_isolation policy',
        },
      ]);
    });

    it('is clean once the reference table is exempt', async () => {
      expect(await check([`${SCHEMA}.countries`])).toEqual([]);
    });

    it('notices row-level security switched off by hand', async () => {
      await admin.query(
        `alter table ${SCHEMA}.notes disable row level security`,
      );
      try {
        expect(await check([`${SCHEMA}.countries`])).toEqual([
          {
            table: `${SCHEMA}.notes`,
            problem: 'does not have row-level security enabled',
          },
        ]);
      } finally {
        await admin.query(
          `alter table ${SCHEMA}.notes enable row level security`,
        );
      }
    });
  });

  describe('connection', () => {
    it('answers a ping', async () => {
      await expect(database.ping()).resolves.toBeUndefined();
    });
  });
});
