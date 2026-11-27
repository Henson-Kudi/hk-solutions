import {
  ScopedRepository,
  createDatabase,
  runWithTenantContext,
  tenantColumns,
  tenantIsolation,
  withTenantTransaction,
  type Database,
  type NewRow,
  type RowPatch,
} from '@hk/platform/db';
import {
  scopedStoreConformance,
  sequentialIds,
  type Note,
  type ScopedStore,
  type ScopedStoreSubject,
} from '@hk/platform/test-kit';
import { text, type PgSchema } from 'drizzle-orm/pg-core';
import {
  createTestSchema,
  postgresTestUrl,
  type TestSchema,
} from './postgres-test-schema';

/**
 * The same conformance suite the in-memory store passes (platform/test-kit),
 * run against platform/db's ScopedRepository on a real PostgreSQL.
 *
 * This is the pattern for every repository port: one suite, and each adapter
 * (infra-pg, infra-sqlite, in-memory fake) runs it in its own test file.
 */
const adminUrl = postgresTestUrl();
const describeWithPostgres = adminUrl ? describe : describe.skip;

describe('test setup', () => {
  it('has a PostgreSQL to test against when running in CI', () => {
    if (process.env['CI']) {
      expect(adminUrl).toBeDefined();
    }
  });
});

const define = (schema: PgSchema) => ({
  notes: schema.table(
    'notes',
    { ...tenantColumns, body: text('body').notNull() },
    (table) => [...tenantIsolation('notes', table)],
  ),
});

type Notes = ReturnType<typeof define>['notes'];

/** Adapts ScopedRepository to the ScopedStore port by making its building blocks public. */
class PgNoteStore extends ScopedRepository<Notes> implements ScopedStore<Note> {
  constructor(table: Notes) {
    super(table);
  }
  override insert(values: NewRow<Notes>) {
    return super.insert(values);
  }
  override findById(id: string) {
    return super.findById(id);
  }
  list() {
    return this.find();
  }
  override update(id: string, expectedVersion: number, patch: RowPatch<Notes>) {
    return super.update(id, expectedVersion, patch);
  }
  override delete(id: string) {
    return super.delete(id);
  }
}

describeWithPostgres(
  'ScopedRepository on PostgreSQL passes the scoped-store conformance suite',
  () => {
    let schema: TestSchema<ReturnType<typeof define>>;
    let database: Database;
    let subject: ScopedStoreSubject;

    beforeAll(async () => {
      schema = await createTestSchema({
        adminUrl: adminUrl as string,
        prefix: 'conformance',
        define,
      });
      database = createDatabase({
        url: schema.appUrl,
        name: 'platform-testing-conformance-spec',
      });
      const store = new PgNoteStore(schema.tables.notes);
      const scopeIds = sequentialIds(10);
      const tenant = scopeIds();
      subject = {
        // One unit of work for one business: a tenant context and a transaction.
        run: (scope, action) =>
          runWithTenantContext(scope, () =>
            withTenantTransaction(database, () => action(store)),
          ),
        nextId: sequentialIds(11),
        scopes: {
          a: { tenantId: tenant, businessId: scopeIds() },
          b: { tenantId: tenant, businessId: scopeIds() },
          otherTenant: { tenantId: scopeIds(), businessId: scopeIds() },
        },
      };
    }, 60_000);

    afterAll(async () => {
      await database?.close();
      await schema?.drop();
    });

    beforeEach(async () => {
      await schema.truncate('notes');
    });

    for (const testCase of scopedStoreConformance) {
      it(testCase.name, async () => {
        await testCase.run(subject);
      });
    }
  },
);
