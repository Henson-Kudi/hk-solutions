import { DomainError } from '@hk/platform/universal';
import {
  index,
  pgPolicy,
  pgSchema,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  TENANT_POLICY_NAME,
  tenantColumns,
  tenantIsolation,
  tenantPredicate,
} from './columns';
import { createDatabase } from './database';
import { findTenantSchemaViolations, tablesOf } from './schema-check';
import {
  getTenantContext,
  requireTenantContext,
  runWithTenantContext,
} from './tenant-context';
import {
  isInTransaction,
  requireSystemTransaction,
  requireTenantTransaction,
} from './transaction';

const TENANT = '018f2c3a-7b1e-7000-8000-00000000000a';
const BUSINESS_A = '018f2c3a-7b1e-7000-8000-0000000000a1';
const BUSINESS_B = '018f2c3a-7b1e-7000-8000-0000000000b1';
const USER = '018f2c3a-7b1e-7000-8000-0000000000c1';

const code = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'NOT_A_DOMAIN_ERROR';
  }
  return 'DID_NOT_THROW';
};

describe('tenant context', () => {
  it('is absent by default, and requiring it throws', () => {
    expect(getTenantContext()).toBeUndefined();
    expect(code(requireTenantContext)).toBe('TENANT_CONTEXT_MISSING');
  });

  it('is visible inside, across awaits, and gone afterwards', async () => {
    await runWithTenantContext(
      { tenantId: TENANT, businessId: BUSINESS_A, userId: USER },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(requireTenantContext()).toEqual({
          tenantId: TENANT,
          businessId: BUSINESS_A,
          userId: USER,
        });
      },
    );
    expect(getTenantContext()).toBeUndefined();
  });

  it('keeps concurrent contexts apart', async () => {
    const seen: Record<string, string | undefined> = {};
    const work = (businessId: string, delay: number) =>
      runWithTenantContext({ tenantId: TENANT, businessId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        seen[businessId] = getTenantContext()?.businessId;
      });
    await Promise.all([work(BUSINESS_A, 5), work(BUSINESS_B, 1)]);
    expect(seen).toEqual({
      [BUSINESS_A]: BUSINESS_A,
      [BUSINESS_B]: BUSINESS_B,
    });
  });

  it('cannot be changed from inside', () => {
    const context = { tenantId: TENANT, businessId: BUSINESS_A };
    runWithTenantContext(context, () => {
      expect(Object.isFrozen(requireTenantContext())).toBe(true);
      expect(
        code(() =>
          runWithTenantContext(
            { tenantId: TENANT, businessId: BUSINESS_B },
            () => undefined,
          ),
        ),
      ).toBe('TENANT_CONTEXT_SWITCH');
      expect(
        code(() =>
          runWithTenantContext(
            { tenantId: BUSINESS_B, businessId: BUSINESS_A },
            () => undefined,
          ),
        ),
      ).toBe('TENANT_CONTEXT_SWITCH');
      expect(requireTenantContext().businessId).toBe(BUSINESS_A);
    });
  });

  it('may be re-entered for the same business, to add the user or branch', () => {
    runWithTenantContext({ tenantId: TENANT, businessId: BUSINESS_A }, () => {
      runWithTenantContext(
        { tenantId: TENANT, businessId: BUSINESS_A, userId: USER },
        () => {
          expect(requireTenantContext().userId).toBe(USER);
        },
      );
      expect(requireTenantContext().userId).toBeUndefined();
    });
  });

  it.each([
    ['tenantId', { tenantId: 'not-a-uuid', businessId: BUSINESS_A }],
    ['businessId', { tenantId: TENANT, businessId: "x'; drop table t; --" }],
    ['businessId', { tenantId: TENANT, businessId: BUSINESS_A.toUpperCase() }],
    ['branchId', { tenantId: TENANT, businessId: BUSINESS_A, branchId: '' }],
    ['userId', { tenantId: TENANT, businessId: BUSINESS_A, userId: '42' }],
  ])('refuses a %s that is not a canonical UUID', (field, context) => {
    try {
      runWithTenantContext(context, () => undefined);
      throw new Error('did not throw');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'TENANT_CONTEXT_INVALID',
        details: { field },
      });
    }
  });
});

describe('transactions, without a database', () => {
  it('has none open by default', () => {
    expect(isInTransaction()).toBe(false);
    expect(code(requireTenantTransaction)).toBe('TRANSACTION_MISSING');
    expect(code(requireSystemTransaction)).toBe('TRANSACTION_MISSING');
  });
});

describe('createDatabase', () => {
  it.each(['mysql://root@localhost/x', 'localhost:5432', '', 'not a url'])(
    'refuses %p without echoing it',
    (bad) => {
      expect(() => createDatabase({ url: bad, name: 'x' })).toThrow(
        'Database URL must start with postgres:// or postgresql://.',
      );
    },
  );
});

describe('findTenantSchemaViolations', () => {
  const sales = pgSchema('sales');

  const invoices = sales.table(
    'invoices',
    { ...tenantColumns, number: text('number').notNull() },
    (table) => [...tenantIsolation('invoices', table)],
  );

  const problems = (
    ...tables: Parameters<typeof findTenantSchemaViolations>[0]
  ) => findTenantSchemaViolations(tables).map((violation) => violation.problem);

  it('accepts a table built with tenantColumns and tenantIsolation', () => {
    expect(findTenantSchemaViolations([invoices])).toEqual([]);
  });

  it('reports a table with nothing', () => {
    const bare = sales.table('bare', { id: uuid('id').primaryKey() });
    expect(findTenantSchemaViolations([bare])).toEqual([
      { table: 'sales.bare', problem: 'has no tenant_id column' },
      { table: 'sales.bare', problem: 'has no business_id column' },
      { table: 'sales.bare', problem: 'has no version column' },
      {
        table: 'sales.bare',
        problem: 'has no index starting with (tenant_id, business_id)',
      },
      { table: 'sales.bare', problem: 'has no tenant_isolation policy' },
    ]);
  });

  it('reports tenant columns without the index or the policy', () => {
    const noIsolation = sales.table('no_isolation', { ...tenantColumns });
    expect(problems(noIsolation)).toEqual([
      'has no index starting with (tenant_id, business_id)',
      'has no tenant_isolation policy',
    ]);
  });

  it('reports nullable or wrongly typed tenant columns', () => {
    const loose = sales.table(
      'loose',
      {
        ...tenantColumns,
        tenantId: uuid('tenant_id'),
        businessId: text('business_id').notNull(),
      },
      (table) => [...tenantIsolation('loose', table)],
    );
    expect(problems(loose)).toEqual([
      'tenant_id is nullable',
      'business_id is not uuid',
    ]);
  });

  it('reports an index in the wrong column order', () => {
    const wrongOrder = sales.table(
      'wrong_order',
      { ...tenantColumns },
      (table) => [
        index('wrong_order_idx').on(table.businessId, table.tenantId),
        pgPolicy(TENANT_POLICY_NAME, {
          using: tenantPredicate,
          withCheck: tenantPredicate,
        }),
      ],
    );
    expect(problems(wrongOrder)).toEqual([
      'has no index starting with (tenant_id, business_id)',
    ]);
  });

  it('reports a policy that reads but does not check writes, or covers one command', () => {
    const readOnlyPolicy = sales.table(
      'read_only_policy',
      { ...tenantColumns },
      (table) => [
        index('rop_idx').on(table.tenantId, table.businessId),
        pgPolicy(TENANT_POLICY_NAME, { for: 'select', using: tenantPredicate }),
      ],
    );
    expect(problems(readOnlyPolicy)).toEqual([
      'tenant_isolation has no WITH CHECK clause',
      'tenant_isolation does not cover all commands',
    ]);
  });

  it('reports a table left in the public schema', () => {
    const inPublic = pgTable('in_public', { ...tenantColumns }, (table) => [
      ...tenantIsolation('in_public', table),
    ]);
    expect(findTenantSchemaViolations([inPublic])).toEqual([
      {
        table: 'public.in_public',
        problem:
          'is in the public schema; a table belongs to its service schema',
      },
    ]);
  });

  it('skips exempt tables by their full name only', () => {
    const countries = sales.table('countries', {
      code: text('code').primaryKey(),
    });
    expect(
      findTenantSchemaViolations([countries, invoices], {
        exempt: ['sales.countries'],
      }),
    ).toEqual([]);
    expect(
      findTenantSchemaViolations([countries], { exempt: ['core.countries'] }),
    ).not.toEqual([]);
  });

  it("collects the tables among a schema module's exports", () => {
    const exports = {
      invoices,
      sales,
      helper: () => 1,
      name: 'x',
      nothing: null,
    };
    expect(tablesOf(exports)).toEqual([invoices]);
  });
});
