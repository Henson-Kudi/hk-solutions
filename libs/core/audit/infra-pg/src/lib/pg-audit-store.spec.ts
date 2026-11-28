import { createHash } from 'node:crypto';
import {
  auditStoreConformance,
  createAuditLog,
  type AuditLog,
  type AuditStoreSubject,
  type RecordAuditInput,
} from '@hk/core/audit/application';
import {
  AUDIT_ERRORS,
  GENESIS_HASH,
  type AuditScope,
} from '@hk/core/audit/domain';
import {
  createDatabase,
  findTenantCatalogViolations,
  findTenantSchemaViolations,
  requireTenantTransaction,
  runWithTenantContext,
  tablesOf,
  withSystemTransaction,
  withTenantTransaction,
  type Database,
} from '@hk/platform/db';
import {
  createTestSchema,
  postgresTestUrl,
  type TestSchema,
} from '@hk/platform/testing';
import {
  createUuidV7Generator,
  isDomainError,
  systemClock,
} from '@hk/platform/universal';
import { sql } from 'drizzle-orm';
import { nodeSha256 } from './node-sha256';
import { PgAuditStore } from './pg-audit-store';
import { auditEventsTable, type AuditEventsTable } from './schema';
import { auditWriteOnceStatements } from './write-once';

/**
 * These need a real PostgreSQL (HK_TEST_DATABASE_URL; `pnpm infra:up`
 * locally). CI always has one.
 */
const adminUrl = postgresTestUrl();
const describeWithPostgres = adminUrl ? describe : describe.skip;

const scopeA: AuditScope = {
  tenantId: '018f0000-0000-7000-8000-00000000000a',
  businessId: '018f0000-0000-7000-8000-00000000000b',
};
const scopeB: AuditScope = {
  tenantId: scopeA.tenantId,
  businessId: '018f0000-0000-7000-8000-00000000000c',
};
const userId = '018f0000-0000-7000-8000-0000000000aa';

const input = (
  overrides: Partial<RecordAuditInput> = {},
): RecordAuditInput => ({
  actor: { type: 'user', id: userId },
  action: 'update',
  entityType: 'sales.invoice',
  entityId: 'inv-1',
  details: { field: 'status', to: 'issued' },
  requestId: 'req-1',
  ...overrides,
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

describe('nodeSha256', () => {
  // Published SHA-256 test vectors (FIPS 180-2).
  it('matches the published vectors', () => {
    expect(nodeSha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(nodeSha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      nodeSha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('hashes text as UTF-8', () => {
    expect(nodeSha256('é 漢 😀')).toBe(
      createHash('sha256').update(Buffer.from('é 漢 😀', 'utf8')).digest('hex'),
    );
    expect(nodeSha256('é')).not.toBe(nodeSha256('e'));
  });
});

describe('auditWriteOnceStatements', () => {
  it('revokes update, delete and truncate from the app role', () => {
    expect(
      auditWriteOnceStatements({ schema: 'core', appRole: 'hk_core_app' }),
    ).toEqual([
      'revoke update, delete, truncate on table core.audit_events from hk_core_app',
    ]);
  });

  it.each([
    ['core; drop table x', 'hk_core_app'],
    ['core', 'hk_core_app; --'],
    ['Core', 'hk_core_app'],
    ['core', ''],
    ['"core"', 'hk_core_app'],
  ])('refuses %j / %j as identifiers', (schema, appRole) => {
    expect(() => auditWriteOnceStatements({ schema, appRole })).toThrow(
      /lower-case letters, digits and underscores/,
    );
  });
});

describeWithPostgres('PgAuditStore', () => {
  let schema: TestSchema<{ auditEvents: AuditEventsTable }>;
  let database: Database;
  let store: PgAuditStore;
  let log: AuditLog;

  /** One unit of work for a business: a tenant context and a transaction. */
  const within = <T>(scope: AuditScope, action: () => Promise<T>): Promise<T> =>
    runWithTenantContext(scope, () => withTenantTransaction(database, action));

  const record = (scope: AuditScope, overrides?: Partial<RecordAuditInput>) =>
    within(scope, () => log.record(scope, input(overrides)));

  const verify = (
    scope: AuditScope,
    options?: Parameters<AuditLog['verify']>[1],
  ) => within(scope, () => log.verify(scope, options));

  const table = () => sql.raw(`${schema.name}.audit_events`);

  beforeAll(async () => {
    schema = await createTestSchema({
      adminUrl: adminUrl as string,
      prefix: 'audit',
      define: (pgSchema) => ({ auditEvents: auditEventsTable(pgSchema) }),
    });
    database = createDatabase({ url: schema.appUrl, name: 'audit-spec' });
    store = new PgAuditStore(schema.tables.auditEvents);
    log = createAuditLog({
      store,
      sha256: nodeSha256,
      clock: systemClock,
      newId: createUuidV7Generator(),
    });
  });

  afterAll(async () => {
    await database?.close();
    await schema?.drop();
  });

  beforeEach(async () => {
    await schema.truncate('audit_events');
  });

  describe('conformance', () => {
    const subject = (): AuditStoreSubject => ({
      store,
      sha256: nodeSha256,
      scopeA,
      scopeB,
      within,
    });
    for (const testCase of auditStoreConformance) {
      it(testCase.name, () => testCase.run(subject()));
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

    it('refuses two events at the same place in a chain', async () => {
      const first = await record(scopeA);
      const message = await messageOf(() =>
        within(scopeA, async () => {
          await requireTenantTransaction().execute(sql`
            insert into ${table()}
              (id, tenant_id, business_id, sequence, occurred_at, actor_type,
               action, entity_type, details, previous_hash, hash)
            values
              ('018f0000-0000-7000-8000-0000000000f1', ${scopeA.tenantId},
               ${scopeA.businessId}, ${first.sequence}, now(), 'system',
               'create', 'core.forged', '{}'::jsonb, ${GENESIS_HASH},
               ${'a'.repeat(64)})`);
        }),
      );
      expect(message).toMatch(/audit_events_business_sequence_uq/);
    });

    it.each([
      [
        'a hash that is not 64 hex characters',
        'xyz',
        1,
        'audit_events_hash_format',
      ],
      [
        'a sequence of zero',
        'a'.repeat(64),
        0,
        'audit_events_sequence_positive',
      ],
    ])('refuses %s', async (_name, hash, sequence, constraint) => {
      const message = await messageOf(() =>
        within(scopeA, async () => {
          await requireTenantTransaction().execute(sql`
            insert into ${table()}
              (id, tenant_id, business_id, sequence, occurred_at, actor_type,
               action, entity_type, details, previous_hash, hash)
            values
              ('018f0000-0000-7000-8000-0000000000f2', ${scopeA.tenantId},
               ${scopeA.businessId}, ${sequence}, now(), 'system', 'create',
               'core.forged', '{}'::jsonb, ${GENESIS_HASH}, ${hash})`);
        }),
      );
      expect(message).toMatch(constraint);
    });
  });

  describe('recording', () => {
    it('records and verifies with real SHA-256', async () => {
      const first = await record(scopeA);
      const second = await record(scopeA, { action: 'approve' });
      expect(first.sequence).toBe(1);
      expect(first.previousHash).toBe(GENESIS_HASH);
      expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(second.previousHash).toBe(first.hash);
      expect(await verify(scopeA)).toEqual({
        ok: true,
        checked: 2,
        head: { sequence: 2, hash: second.hash },
      });
    });

    it('is undone when the transaction it is part of rolls back', async () => {
      await record(scopeA);
      await expect(
        within(scopeA, async () => {
          await log.record(scopeA, input({ entityId: 'inv-rolled-back' }));
          throw new Error('the business change failed');
        }),
      ).rejects.toThrow('the business change failed');

      const events = await within(scopeA, () => log.list(scopeA));
      expect(events.map((event) => event.entityId)).toEqual(['inv-1']);
      // The sequence the rolled-back event had is used by the next one.
      const next = await record(scopeA, { entityId: 'inv-2' });
      expect(next.sequence).toBe(2);
      expect((await verify(scopeA)).ok).toBe(true);
    });

    it('records several events in one transaction', async () => {
      await within(scopeA, async () => {
        await log.record(scopeA, input({ entityId: 'a' }));
        await log.record(scopeA, input({ entityId: 'b' }));
        await log.record(scopeA, input({ entityId: 'c' }));
      });
      expect(await verify(scopeA)).toMatchObject({ ok: true, checked: 3 });
    });

    it('keeps one chain when many transactions record at once', async () => {
      const count = 30;
      await Promise.all(
        Array.from({ length: count }, (_, n) =>
          record(scopeA, { entityId: `inv-${n}` }),
        ),
      );
      const result = await verify(scopeA);
      expect(result).toMatchObject({ ok: true, checked: count });
      const events = await within(scopeA, () =>
        log.list(scopeA, { limit: 100 }),
      );
      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: count }, (_, n) => n + 1),
      );
    });

    it('lets two businesses record at once without waiting on each other’s chain', async () => {
      await Promise.all([
        ...Array.from({ length: 10 }, () => record(scopeA)),
        ...Array.from({ length: 10 }, () => record(scopeB)),
      ]);
      expect(await verify(scopeA)).toMatchObject({ ok: true, checked: 10 });
      expect(await verify(scopeB)).toMatchObject({ ok: true, checked: 10 });
    });

    it('stamps the user of the tenant context as the creator of the row', async () => {
      await runWithTenantContext({ ...scopeA, userId }, () =>
        withTenantTransaction(database, () => log.record(scopeA, input())),
      );
      const rows = await schema.admin.query(
        `select created_by from ${schema.name}.audit_events`,
      );
      expect(rows.rows).toEqual([{ created_by: userId }]);
    });
  });

  describe('tenant isolation', () => {
    it('refuses a scope that is not the business the work runs for', async () => {
      await record(scopeA);
      const actions: (() => Promise<unknown>)[] = [
        () => store.head(scopeA),
        () => store.read(scopeA, { afterSequence: 0, limit: 10 }),
        () => log.record(scopeA, input()),
        () => log.verify(scopeA),
      ];
      for (const action of actions) {
        // Running as business B, naming business A.
        expect(await messageOf(() => within(scopeB, action))).toBe(
          AUDIT_ERRORS.SCOPE_MISMATCH,
        );
      }
    });

    it('hides one business’s events from another, even from hand-written SQL', async () => {
      await record(scopeA);
      await record(scopeA);
      const seenByB = await within(scopeB, () =>
        requireTenantTransaction().execute(sql`select id from ${table()}`),
      );
      expect(seenByB.rows).toEqual([]);
      const seenByA = await within(scopeA, () =>
        requireTenantTransaction().execute(sql`select id from ${table()}`),
      );
      expect(seenByA.rows).toHaveLength(2);
    });

    it('refuses a row written for another business, even by hand-written SQL', async () => {
      const message = await messageOf(() =>
        within(scopeB, async () => {
          await requireTenantTransaction().execute(sql`
            insert into ${table()}
              (id, tenant_id, business_id, sequence, occurred_at, actor_type,
               action, entity_type, details, previous_hash, hash)
            values
              ('018f0000-0000-7000-8000-0000000000f3', ${scopeA.tenantId},
               ${scopeA.businessId}, 1, now(), 'system', 'create',
               'core.forged', '{}'::jsonb, ${GENESIS_HASH}, ${'a'.repeat(64)})`);
        }),
      );
      expect(message).toMatch(/row-level security/);
    });

    it('shows nothing outside a tenant transaction', async () => {
      await record(scopeA);
      const rows = await withSystemTransaction(database, (transaction) =>
        transaction.execute(sql`select id from ${table()}`),
      );
      expect(rows.rows).toEqual([]);
    });

    it('cannot be used without a tenant transaction', async () => {
      expect(await messageOf(() => store.head(scopeA))).not.toBe(
        'nothing was thrown',
      );
      expect(
        await messageOf(() =>
          runWithTenantContext(scopeA, () => store.head(scopeA)),
        ),
      ).not.toBe('nothing was thrown');
    });
  });

  describe('tampering behind the application’s back', () => {
    // The admin connection is a superuser: it can do what the app role
    // cannot. The chain does not stop it. The chain shows it.
    const admin = (text: string, values: unknown[] = []) =>
      schema.admin.query(text, values);

    const fill = async (count: number) => {
      const events = [];
      for (let n = 1; n <= count; n += 1) {
        events.push(await record(scopeA, { entityId: `inv-${n}` }));
      }
      return events;
    };

    it('shows an edited event', async () => {
      await fill(8);
      await admin(
        `update ${schema.name}.audit_events set details = '{"field":"total","to":"0"}'::jsonb where sequence = 5`,
      );
      expect(await verify(scopeA, { pageSize: 3 })).toEqual({
        ok: false,
        reason: 'hash',
        brokenAt: 5,
        checked: 4,
      });
    });

    it.each([
      ['the actor', `actor_id = '018f0000-0000-7000-8000-0000000000bb'`],
      ['the action', `action = 'delete'`],
      ['the time', `occurred_at = occurred_at - interval '1 day'`],
      ['the record it is about', `entity_id = 'inv-999'`],
      ['the request id', `request_id = null`],
    ])('shows a change to %s', async (_name, change) => {
      await fill(4);
      await admin(
        `update ${schema.name}.audit_events set ${change} where sequence = 2`,
      );
      expect(await verify(scopeA)).toMatchObject({
        ok: false,
        reason: 'hash',
        brokenAt: 2,
      });
    });

    it('shows a removed event', async () => {
      await fill(8);
      await admin(`delete from ${schema.name}.audit_events where sequence = 3`);
      expect(await verify(scopeA)).toEqual({
        ok: false,
        reason: 'sequence',
        brokenAt: 4,
        checked: 2,
      });
    });

    it('shows events cut off the end, against a saved head', async () => {
      const events = await fill(8);
      const last = events[7];
      if (!last) throw new Error('no last event');
      const saved = { sequence: last.sequence, hash: last.hash };
      await admin(`delete from ${schema.name}.audit_events where sequence > 5`);
      expect((await verify(scopeA)).ok).toBe(true);
      expect(await verify(scopeA, { expectedHead: saved })).toEqual({
        ok: false,
        reason: 'head',
        brokenAt: 8,
        checked: 5,
      });
    });

    it('does not mind the database reordering the keys of the details', async () => {
      await record(scopeA, {
        details: { zebra: 1, apple: { y: 2, x: 1 }, mango: [3, 2, 1] },
      });
      const stored = await admin(
        `select details::text as text from ${schema.name}.audit_events`,
      );
      // jsonb stores keys in its own order, not the order they were written in.
      expect(stored.rows[0].text).not.toBe(
        '{"zebra":1,"apple":{"y":2,"x":1},"mango":[3,2,1]}',
      );
      expect((await verify(scopeA)).ok).toBe(true);
    });
  });

  describe('write-once', () => {
    // These change the app role's rights, so they run last and restore them.
    const appRole = () => `${schema.name}_app`;

    beforeAll(async () => {
      for (const statement of auditWriteOnceStatements({
        schema: schema.name,
        appRole: appRole(),
      })) {
        await schema.admin.query(statement);
      }
    });

    afterAll(async () => {
      await schema.admin.query(
        `grant update, delete, truncate on table ${schema.name}.audit_events to ${appRole()}`,
      );
    });

    it('still lets the application record and read', async () => {
      await record(scopeA);
      await record(scopeA);
      expect(await verify(scopeA)).toMatchObject({ ok: true, checked: 2 });
    });

    it.each([
      ['update', (name: string) => `update ${name} set action = 'delete'`],
      ['delete', (name: string) => `delete from ${name}`],
      ['truncate', (name: string) => `truncate ${name}`],
    ])('refuses the application an %s', async (_verb, statement) => {
      await record(scopeA);
      const message = await messageOf(() =>
        within(scopeA, async () => {
          await requireTenantTransaction().execute(
            sql.raw(statement(`${schema.name}.audit_events`)),
          );
        }),
      );
      expect(message).toMatch(/permission denied for table audit_events/);
      expect(await verify(scopeA)).toMatchObject({ ok: true, checked: 1 });
    });
  });
});
