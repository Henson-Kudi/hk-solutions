import {
  fileRecordsConformance,
  type FileRecordsSubject,
  type NewFileRecord,
} from '@hk/core/files/application';
import { objectKeyFor, type FileScope } from '@hk/core/files/domain';
import {
  createDatabase,
  findTenantCatalogViolations,
  findTenantSchemaViolations,
  requireTenantTransaction,
  tablesOf,
  withSystemTransaction,
  type Database,
} from '@hk/platform/db';
import {
  createTestSchema,
  postgresTestUrl,
  type TestSchema,
} from '@hk/platform/testing';
import { isDomainError } from '@hk/platform/universal';
import { sql } from 'drizzle-orm';
import { PgFileRecords, createPgUnitOfWork } from './pg-file-records';
import { filesTable, type FilesTable } from './schema';

/**
 * These need a real PostgreSQL (HK_TEST_DATABASE_URL; `pnpm infra:up`
 * locally). CI always has one.
 */
const adminUrl = postgresTestUrl();
const describeWithPostgres = adminUrl ? describe : describe.skip;

const scopeA: FileScope = {
  tenantId: '018f0000-0000-7000-8000-00000000000a',
  businessId: '018f0000-0000-7000-8000-00000000000b',
};
const scopeB: FileScope = {
  tenantId: scopeA.tenantId,
  businessId: '018f0000-0000-7000-8000-00000000000c',
};
const SHA = 'ab'.repeat(32);

const fileId = (n: number): string =>
  `018f0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const newRecord = (scope: FileScope, n: number): NewFileRecord => ({
  id: fileId(n),
  purpose: 'attachment',
  name: `file-${n}.pdf`,
  contentType: 'application/pdf',
  objectKey: objectKeyFor(scope, fileId(n)),
  createdAt: '2026-11-28T09:00:00.123Z',
  createdBy: null,
});

const messageOf = async (action: () => Promise<unknown>): Promise<string> => {
  try {
    await action();
  } catch (error) {
    if (isDomainError(error)) return error.code;
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
  return 'nothing was thrown';
};

describe('test setup', () => {
  it('has a PostgreSQL to test against when running in CI', () => {
    if (process.env['CI']) {
      expect(adminUrl).toBeDefined();
    }
  });
});

describeWithPostgres('PgFileRecords', () => {
  let schema: TestSchema<{ files: FilesTable }>;
  let database: Database;
  let records: PgFileRecords;
  let within: FileRecordsSubject['within'];

  const table = () => sql.raw(`${schema.name}.files`);

  beforeAll(async () => {
    schema = await createTestSchema({
      adminUrl: adminUrl as string,
      prefix: 'files',
      define: (pgSchema) => ({ files: filesTable(pgSchema) }),
    });
    database = createDatabase({ url: schema.appUrl, name: 'files-spec' });
    records = new PgFileRecords(schema.tables.files);
    const unitOfWork = createPgUnitOfWork(database);
    within = (scope, action) => unitOfWork.run(scope, action);
  });

  afterAll(async () => {
    await database?.close();
    await schema?.drop();
  });

  beforeEach(async () => {
    await schema.truncate('files');
  });

  describe('conformance', () => {
    for (const testCase of fileRecordsConformance) {
      it(testCase.name, () =>
        testCase.run({ records, scopeA, scopeB, within }),
      );
    }
  });

  describe('the table', () => {
    it('follows the tenancy rules, in its definition and in the database', async () => {
      expect(findTenantSchemaViolations(tablesOf(schema.tables))).toEqual([]);
      const violations = await withSystemTransaction(database, (transaction) =>
        findTenantCatalogViolations(transaction, schema.name),
      );
      expect(violations).toEqual([]);
    });

    it('refuses two records for the same object', async () => {
      await within(scopeA, () => records.create(scopeA, newRecord(scopeA, 1)));
      const clash = {
        ...newRecord(scopeA, 2),
        objectKey: objectKeyFor(scopeA, fileId(1)),
      };
      expect(
        await messageOf(() =>
          within(scopeA, () => records.create(scopeA, clash)),
        ),
      ).toMatch(/files_object_key_uq/);
    });

    it.each([
      ['a status that does not exist', `status = 'archived'`, 'files_status'],
      ['a stored file with no size', `status = 'stored'`, 'files_stored_facts'],
      [
        'a stored file with a malformed hash',
        `status = 'stored', size = 1, sha256 = 'xyz'`,
        'files_stored_facts',
      ],
      [
        'a negative size',
        `status = 'stored', size = -1, sha256 = '${SHA}'`,
        'files_stored_facts',
      ],
      [
        'a pending file that already has a size',
        `size = 10`,
        'files_stored_facts',
      ],
    ])('refuses %s', async (_name, change, constraint) => {
      await within(scopeA, () => records.create(scopeA, newRecord(scopeA, 1)));
      const message = await messageOf(() =>
        within(scopeA, async () => {
          await requireTenantTransaction().execute(
            sql`update ${table()} set ${sql.raw(change)}`,
          );
        }),
      );
      expect(message).toMatch(constraint);
    });

    it('moves version and updated_at when a record changes', async () => {
      await within(scopeA, () => records.create(scopeA, newRecord(scopeA, 1)));
      const before = await schema.admin.query(
        `select version, updated_at from ${schema.name}.files`,
      );
      await within(scopeA, () =>
        records.markStored(scopeA, fileId(1), { size: 5, sha256: SHA }),
      );
      const after = await schema.admin.query(
        `select version, updated_at from ${schema.name}.files`,
      );
      expect(before.rows[0].version).toBe(1);
      expect(after.rows[0].version).toBe(2);
      expect(after.rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(
        before.rows[0].updated_at.getTime(),
      );
    });
  });

  describe('tenant isolation', () => {
    it('refuses a scope that is not the business the work runs for', async () => {
      await within(scopeA, () => records.create(scopeA, newRecord(scopeA, 1)));
      const actions: (() => Promise<unknown>)[] = [
        () => records.find(scopeA, fileId(1)),
        () => records.create(scopeA, newRecord(scopeA, 2)),
        () => records.markStored(scopeA, fileId(1), { size: 1, sha256: SHA }),
        () => records.markDeleted(scopeA, fileId(1)),
        () => records.discardPending(scopeA, fileId(1)),
      ];
      for (const action of actions) {
        // Running as business B, naming business A.
        expect(await messageOf(() => within(scopeB, action))).toBe(
          'FILE_SCOPE_MISMATCH',
        );
      }
    });

    it('hides one business’s files from another, even from hand-written SQL', async () => {
      await within(scopeA, () => records.create(scopeA, newRecord(scopeA, 1)));
      const seenByB = await within(scopeB, () =>
        requireTenantTransaction().execute(sql`select id from ${table()}`),
      );
      expect(seenByB.rows).toEqual([]);
      const changedByB = await within(scopeB, () =>
        requireTenantTransaction().execute(
          sql`update ${table()} set name = 'taken.pdf' returning id`,
        ),
      );
      expect(changedByB.rows).toEqual([]);
      const row = await schema.admin.query(
        `select name from ${schema.name}.files`,
      );
      expect(row.rows).toEqual([{ name: 'file-1.pdf' }]);
    });

    it('refuses a row written for another business, even by hand-written SQL', async () => {
      const message = await messageOf(() =>
        within(scopeB, async () => {
          await requireTenantTransaction().execute(sql`
            insert into ${table()}
              (id, tenant_id, business_id, purpose, name, content_type, status,
               object_key, uploaded_at)
            values
              (${fileId(9)}, ${scopeA.tenantId}, ${scopeA.businessId},
               'attachment', 'x.pdf', 'application/pdf', 'pending',
               ${objectKeyFor(scopeA, fileId(9))}, now())`);
        }),
      );
      expect(message).toMatch(/row-level security/);
    });

    it('cannot be used without a tenant transaction', async () => {
      expect(await messageOf(() => records.find(scopeA, fileId(1)))).not.toBe(
        'nothing was thrown',
      );
    });
  });

  describe('unit of work', () => {
    it('saves the calls made inside it together, or not at all', async () => {
      await expect(
        within(scopeA, async () => {
          await records.create(scopeA, newRecord(scopeA, 1));
          await records.create(scopeA, newRecord(scopeA, 2));
          throw new Error('something failed');
        }),
      ).rejects.toThrow('something failed');
      expect(
        await within(scopeA, () => records.find(scopeA, fileId(1))),
      ).toBeNull();

      await within(scopeA, async () => {
        await records.create(scopeA, newRecord(scopeA, 1));
        await records.markStored(scopeA, fileId(1), { size: 3, sha256: SHA });
      });
      const found = await within(scopeA, () => records.find(scopeA, fileId(1)));
      expect(found?.status).toBe('stored');
    });

    it('keeps two businesses’ work apart when they run at once', async () => {
      await Promise.all([
        ...[1, 2, 3, 4, 5].map((n) =>
          within(scopeA, () => records.create(scopeA, newRecord(scopeA, n))),
        ),
        ...[6, 7, 8, 9, 10].map((n) =>
          within(scopeB, () => records.create(scopeB, newRecord(scopeB, n))),
        ),
      ]);
      const count = await schema.admin.query(
        `select business_id, count(*)::int as n from ${schema.name}.files group by business_id order by business_id`,
      );
      expect(count.rows).toEqual([
        { business_id: scopeA.businessId, n: 5 },
        { business_id: scopeB.businessId, n: 5 },
      ]);
    });
  });
});
