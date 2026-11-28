import { createAuditLog, type AuditLog } from '@hk/core/audit/application';
import {
  PgAuditStore,
  auditEventsTable,
  nodeSha256,
  type AuditEventsTable,
} from '@hk/core/audit/infra-pg';
import {
  createAccess,
  createAccessAudit,
  createFixedEntitlements,
  membershipDirectoryConformance,
  membershipRepositoryConformance,
  roleRepositoryConformance,
  type AccessService,
  type AccessStorageSubject,
  type BusinessScope,
} from '@hk/core/identity/application';
import { IDENTITY_ERRORS } from '@hk/core/identity/domain';
import {
  createDatabase,
  findTenantCatalogViolations,
  findTenantSchemaViolations,
  requireSystemTransaction,
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
import {
  FixedClock,
  createUuidV7Generator,
  isDomainError,
} from '@hk/platform/universal';
import { sql } from 'drizzle-orm';
import {
  ACCESS_GLOBAL_TABLES,
  accessTables,
  type AccessTables,
} from './access-schema';
import {
  PgMembershipDirectory,
  PgMembershipRepository,
  PgRoleRepository,
  createPgAccessUnitOfWork,
} from './pg-access';
import { PgUserRepository } from './pg-repositories';
import { identityTables, type IdentityTables } from './schema';

// Every name, phone number and id in this file is invented.

const adminUrl = postgresTestUrl();
const describeWithPostgres = adminUrl ? describe : describe.skip;

const TENANT = '018f0000-0000-7000-8000-00000000f001';
const SHOP: BusinessScope = {
  tenantId: TENANT,
  businessId: '018f0000-0000-7000-8000-00000000b001',
};
const DEPOT: BusinessScope = {
  tenantId: TENANT,
  businessId: '018f0000-0000-7000-8000-00000000b002',
};

describe('test setup', () => {
  it('has a PostgreSQL to test against when running in CI', () => {
    if (process.env['CI']) {
      expect(adminUrl).toBeDefined();
    }
  });
});

describeWithPostgres('access on PostgreSQL', () => {
  let schema: TestSchema<
    IdentityTables & AccessTables & { auditEvents: AuditEventsTable }
  >;
  let database: Database;
  let storage: AccessStorageSubject;
  let users: PgUserRepository;

  const table = (name: string) => sql.raw(`${schema.name}.${name}`);

  const errorOf = async (action: () => Promise<unknown>): Promise<string> => {
    try {
      await action();
    } catch (error) {
      if (isDomainError(error)) return error.code;
      const cause = (error as { cause?: { message?: string } }).cause;
      return cause?.message ?? (error as Error).message;
    }
    return 'nothing was thrown';
  };

  /** Runs raw SQL as the app role inside one business, as a service would. */
  const inBusiness = <Row extends Record<string, unknown>>(
    scope: BusinessScope,
    statement: ReturnType<typeof sql>,
  ): Promise<Row[]> =>
    storage.unitOfWork.tenant(scope, async () => {
      const result = await requireTenantTransaction().execute<Row>(statement);
      return result.rows as unknown as Row[];
    });

  beforeAll(async () => {
    schema = await createTestSchema({
      adminUrl: adminUrl as string,
      prefix: 'access',
      define: (pgSchema) => ({
        ...identityTables(pgSchema),
        ...accessTables(pgSchema),
        auditEvents: auditEventsTable(pgSchema),
      }),
    });
    database = createDatabase({
      url: schema.appUrl,
      name: 'access-spec',
      maxConnections: 12,
    });
    storage = {
      roles: new PgRoleRepository(schema.tables),
      memberships: new PgMembershipRepository(schema.tables),
      directory: new PgMembershipDirectory(schema.tables),
      unitOfWork: createPgAccessUnitOfWork(database),
    };
    users = new PgUserRepository(schema.tables);
  });

  afterAll(async () => {
    await database?.close();
    await schema?.drop();
  });

  beforeEach(async () => {
    await schema.truncate(
      'roles',
      'memberships',
      'user_businesses',
      'audit_events',
    );
    await schema.admin.query(`delete from ${schema.name}.users`);
  });

  describe('PgRoleRepository conformance', () => {
    for (const testCase of roleRepositoryConformance) {
      it(testCase.name, () => testCase.run(storage));
    }
  });

  describe('PgMembershipRepository conformance', () => {
    for (const testCase of membershipRepositoryConformance) {
      it(testCase.name, () => testCase.run(storage));
    }
  });

  describe('PgMembershipDirectory conformance', () => {
    for (const testCase of membershipDirectoryConformance) {
      it(testCase.name, () => testCase.run(storage));
    }
  });

  describe('the tables', () => {
    const tenantScoped = () => {
      const { roles, memberships } = schema.tables;
      return tablesOf({ roles, memberships });
    };

    it('keep roles and memberships behind the tenancy rules, with no exemption', async () => {
      expect(findTenantSchemaViolations(tenantScoped())).toEqual([]);
      const inDatabase = await withSystemTransaction(database, () =>
        findTenantCatalogViolations(requireSystemTransaction(), schema.name, {
          // Everything else in this test schema is a global identity table.
          exempt: [
            'users',
            'user_identifiers',
            'otp_challenges',
            'sessions',
            'session_token_pairs',
            'password_attempts',
            'passkeys',
            'passkey_challenges',
            ...ACCESS_GLOBAL_TABLES,
          ].map((name) => `${schema.name}.${name}`),
        }),
      );
      expect(inDatabase).toEqual([]);
    });

    it('exempt the directory, and only the directory', () => {
      expect(ACCESS_GLOBAL_TABLES).toEqual(['user_businesses']);
      const flagged = new Set(
        findTenantSchemaViolations(
          tablesOf({ directory: schema.tables.userBusinesses }),
        ).map((violation) => violation.table),
      );
      expect([...flagged]).toEqual([`${schema.name}.user_businesses`]);
    });

    const insertRole = (
      scope: BusinessScope,
      id: string,
      name: string,
      key: string | null = null,
    ) =>
      inBusiness(
        scope,
        sql`insert into ${table('roles')}
              (id, tenant_id, business_id, key, name, permissions)
            values (${id}, ${scope.tenantId}, ${scope.businessId}, ${key},
                    ${name}, '{}')`,
      );

    const ROLE_1 = '018f0000-0000-7000-8000-000000006001';
    const ROLE_2 = '018f0000-0000-7000-8000-000000006002';

    it('show a business only its own rows, whatever the SQL says', async () => {
      await insertRole(SHOP, ROLE_1, 'Helper');
      // No WHERE clause at all: row-level security is what filters.
      const count = sql`select count(*)::int as n from ${table('roles')}`;
      expect((await inBusiness<{ n: number }>(SHOP, count))[0]?.n).toBe(1);
      expect((await inBusiness<{ n: number }>(DEPOT, count))[0]?.n).toBe(0);
      const outside = await withSystemTransaction(database, async () => {
        const result = await requireSystemTransaction().execute<{ n: number }>(
          count,
        );
        return result.rows[0]?.n;
      });
      expect(outside).toBe(0);
    });

    it('refuse a row written for another business', async () => {
      const message = await errorOf(() =>
        inBusiness(
          DEPOT,
          sql`insert into ${table('roles')}
                (id, tenant_id, business_id, name, permissions)
              values (${ROLE_1}, ${SHOP.tenantId}, ${SHOP.businessId},
                      'Planted', '{}')`,
        ),
      );
      expect(message).toMatch(/row-level security/);
      const moved = await errorOf(async () => {
        await insertRole(SHOP, ROLE_1, 'Helper');
        await inBusiness(
          SHOP,
          sql`update ${table('roles')} set business_id = ${DEPOT.businessId}
              where id = ${ROLE_1}`,
        );
      });
      expect(moved).toMatch(/row-level security/);
    });

    it.each<[string, string, () => Promise<unknown>]>([
      [
        'two copies of a built-in role in one business',
        'roles_business_key_uq',
        async () => {
          await insertRole(SHOP, ROLE_1, 'Manager', 'manager');
          await insertRole(SHOP, ROLE_2, 'Second manager', 'manager');
        },
      ],
      [
        'two roles with the same name in another case',
        'roles_business_name_uq',
        async () => {
          await insertRole(SHOP, ROLE_1, 'Helper');
          await insertRole(SHOP, ROLE_2, 'HELPER');
        },
      ],
      [
        'a built-in key that does not exist',
        'roles_key',
        () => insertRole(SHOP, ROLE_1, 'Admin', 'admin'),
      ],
      [
        'a membership with an unknown status',
        'memberships_status',
        () =>
          inBusiness(
            SHOP,
            sql`insert into ${table('memberships')}
                  (id, tenant_id, business_id, user_id, role_id, status, joined_at)
                values (${ROLE_1}, ${SHOP.tenantId}, ${SHOP.businessId},
                        ${ROLE_2}, ${ROLE_1}, 'banned', now())`,
          ),
      ],
      [
        'a membership limited to no branch at all',
        'memberships_branches',
        () =>
          inBusiness(
            SHOP,
            sql`insert into ${table('memberships')}
                  (id, tenant_id, business_id, user_id, role_id, branch_ids,
                   status, joined_at)
                values (${ROLE_1}, ${SHOP.tenantId}, ${SHOP.businessId},
                        ${ROLE_2}, ${ROLE_1}, '{}', 'active', now())`,
          ),
      ],
    ])('refuse %s', async (_name, constraint, insert) => {
      expect(await errorOf(insert)).toContain(constraint);
    });

    it('let two businesses each have their own copy of a built-in role and a name', async () => {
      await insertRole(SHOP, ROLE_1, 'Manager', 'manager');
      await insertRole(DEPOT, ROLE_2, 'Manager', 'manager');
      const count = sql`select count(*)::int as n from ${table('roles')}`;
      expect((await inBusiness<{ n: number }>(DEPOT, count))[0]?.n).toBe(1);
    });
  });

  describe('the access use cases, on the real database', () => {
    let access: AccessService;
    let newId: () => string;
    let owner: string;
    let phones: number;

    const person = async (name: string): Promise<string> => {
      phones += 1;
      const phone = {
        kind: 'phone',
        value: `+2376000000${String(phones).padStart(2, '0')}`,
      } as const;
      const id = newId();
      await withSystemTransaction(database, async () => {
        await users.create({
          id,
          name,
          locale: 'en',
          identifiers: [phone],
          passwordHash: null,
          createdAt: '2026-11-28T09:00:00.000Z',
        });
        await users.markIdentifierVerified(
          id,
          phone,
          '2026-11-28T09:00:00.000Z',
        );
      });
      return id;
    };

    const roleId = async (key: 'cashier' | 'manager'): Promise<string> =>
      (
        await storage.unitOfWork.tenant(SHOP, () =>
          storage.roles.findByKey(key),
        )
      )?.id as string;

    const make = (audit?: Parameters<typeof createAccess>[0]['audit']) =>
      createAccess({
        users,
        ...storage,
        entitlements: createFixedEntitlements(['sales', 'pos', 'inventory']),
        audit,
        clock: new FixedClock('2026-11-28T09:00:00.000Z'),
        newId,
      });

    beforeEach(async () => {
      newId = createUuidV7Generator();
      phones = 0;
      access = make();
      owner = await person('Ada Owner');
      await access.provisionBusiness({ scope: SHOP, ownerUserId: owner });
    });

    it('provisions a business, adds a member and authorizes them', async () => {
      expect(
        await access.listRoles({ scope: SHOP, actorUserId: owner }),
      ).toHaveLength(8);
      const cy = await person('Cy Cashier');
      const branch = '018f0000-0000-7000-8000-00000000bb01';
      const membership = await access.addMember({
        scope: SHOP,
        actorUserId: owner,
        userId: cy,
        roleId: await roleId('cashier'),
        branchIds: [branch],
      });
      const result = await access.authorize({
        userId: cy,
        businessId: SHOP.businessId,
        branchId: branch,
      });
      expect(result).toMatchObject({
        tenantId: TENANT,
        membershipId: membership.id,
        roleKey: 'cashier',
        isOwner: false,
        branchIds: [branch],
        branchId: branch,
      });
      expect(result.permissions).toContain('invoices:issue');
      expect(result.permissions).not.toContain('invoices:void');
      expect(await access.listBusinesses({ userId: cy })).toEqual([SHOP]);
      expect(
        (await access.listMembers({ scope: SHOP, actorUserId: owner })).map(
          (member) => member.name,
        ),
      ).toEqual(['Ada Owner', 'Cy Cashier']);
    });

    it('cuts a suspended member off, and a stranger never gets in', async () => {
      const cy = await person('Cy Cashier');
      const membership = await access.addMember({
        scope: SHOP,
        actorUserId: owner,
        userId: cy,
        roleId: await roleId('cashier'),
      });
      await access.suspendMember({
        scope: SHOP,
        actorUserId: owner,
        membershipId: membership.id,
      });
      const stranger = await person('Sam Stranger');
      for (const userId of [cy, stranger]) {
        expect(
          await errorOf(() =>
            access.authorize({ userId, businessId: SHOP.businessId }),
          ),
        ).toBe(IDENTITY_ERRORS.ACCESS_DENIED);
      }
      expect(await access.listBusinesses({ userId: cy })).toEqual([]);
    });

    it('keeps one business’s owner out of another', async () => {
      const other = await person('Dee Depot');
      await access.provisionBusiness({ scope: DEPOT, ownerUserId: other });
      expect(
        await errorOf(() =>
          access.listMembers({ scope: DEPOT, actorUserId: owner }),
        ),
      ).toBe(IDENTITY_ERRORS.ACCESS_DENIED);
      expect(
        await errorOf(() =>
          access.authorize({ userId: owner, businessId: DEPOT.businessId }),
        ),
      ).toBe(IDENTITY_ERRORS.ACCESS_DENIED);
    });

    it('adds a person once when two requests add them at the same moment', async () => {
      const cy = await person('Cy Cashier');
      const cashier = await roleId('cashier');
      const outcomes = await Promise.all(
        [1, 2].map(() =>
          errorOf(() =>
            access.addMember({
              scope: SHOP,
              actorUserId: owner,
              userId: cy,
              roleId: cashier,
            }),
          ),
        ),
      );
      expect(outcomes.sort()).toEqual(
        [IDENTITY_ERRORS.MEMBER_EXISTS, 'nothing was thrown'].sort(),
      );
      expect(
        await access.listMembers({ scope: SHOP, actorUserId: owner }),
      ).toHaveLength(2);
    });

    it('gives a business one set of roles and one owner when provisioned twice at once', async () => {
      const dee = await person('Dee Depot');
      const outcomes = await Promise.all(
        [1, 2].map(() =>
          errorOf(() =>
            access.provisionBusiness({ scope: DEPOT, ownerUserId: dee }),
          ),
        ),
      );
      // One of the two may lose the race and fail; what matters is what is
      // left: never two copies of a role, never two owners.
      expect(outcomes).toContain('nothing was thrown');
      await access.provisionBusiness({ scope: DEPOT, ownerUserId: dee });
      expect(
        await access.listRoles({ scope: DEPOT, actorUserId: dee }),
      ).toHaveLength(8);
      expect(
        await access.listMembers({ scope: DEPOT, actorUserId: dee }),
      ).toHaveLength(1);
    });

    it('writes the membership and its directory line together, or neither', async () => {
      const cy = await person('Cy Cashier');
      const failing = make({
        record: async () => {
          throw new Error('the audit log is down');
        },
      });
      expect(
        await errorOf(async () =>
          failing.addMember({
            scope: SHOP,
            actorUserId: owner,
            userId: cy,
            roleId: await roleId('cashier'),
          }),
        ),
      ).toBe('the audit log is down');
      expect(
        await access.listMembers({ scope: SHOP, actorUserId: owner }),
      ).toHaveLength(1);
      expect(await access.listBusinesses({ userId: cy })).toEqual([]);
      const lines = await schema.admin.query(
        `select 1 from ${schema.name}.user_businesses where user_id = $1`,
        [cy],
      );
      expect(lines.rows).toEqual([]);
    });

    describe('with the business audit log', () => {
      let log: AuditLog;
      let audited: AccessService;

      beforeEach(() => {
        log = createAuditLog({
          store: new PgAuditStore(schema.tables.auditEvents),
          sha256: nodeSha256,
          clock: new FixedClock('2026-11-28T09:00:00.000Z'),
          newId,
        });
        audited = make(createAccessAudit(log));
      });

      const trail = () => storage.unitOfWork.tenant(SHOP, () => log.list(SHOP));

      it('records each change in the business’s own chain, which verifies', async () => {
        const cy = await person('Cy Cashier');
        const membership = await audited.addMember({
          scope: SHOP,
          actorUserId: owner,
          userId: cy,
          roleId: await roleId('cashier'),
        });
        await audited.suspendMember({
          scope: SHOP,
          actorUserId: owner,
          membershipId: membership.id,
        });
        const events = await trail();
        expect(
          events.map((event) => [
            event.entityType,
            event.action,
            event.actor,
            event.entityId,
          ]),
        ).toEqual([
          [
            'core.membership',
            'create',
            { type: 'user', id: owner },
            membership.id,
          ],
          [
            'core.membership',
            'update',
            { type: 'user', id: owner },
            membership.id,
          ],
        ]);
        expect(events[1]?.details).toMatchObject({
          change: 'suspend',
          status: 'suspended',
        });
        const check = await storage.unitOfWork.tenant(SHOP, () =>
          log.verify(SHOP),
        );
        expect(check.ok).toBe(true);
        // No name and no phone number is ever written to the trail.
        expect(JSON.stringify(events)).not.toMatch(/Cy Cashier|\+237/);
      });

      it('writes no audit event for a change that was refused', async () => {
        const cy = await person('Cy Cashier');
        expect(
          await errorOf(async () =>
            audited.addMember({
              scope: SHOP,
              actorUserId: cy,
              userId: cy,
              roleId: await roleId('cashier'),
            }),
          ),
        ).toBe(IDENTITY_ERRORS.ACCESS_DENIED);
        expect(await trail()).toEqual([]);
      });

      it('keeps another business’s trail empty', async () => {
        const dee = await person('Dee Depot');
        await audited.provisionBusiness({ scope: DEPOT, ownerUserId: dee });
        expect(await trail()).toEqual([]);
        const theirs = await storage.unitOfWork.tenant(DEPOT, () =>
          log.list(DEPOT),
        );
        expect(theirs).toHaveLength(1);
      });
    });

    it('refuses a change made from a copy that is out of date', async () => {
      const helper = await access.createRole({
        scope: SHOP,
        actorUserId: owner,
        name: 'Helper',
        permissions: ['invoices:view'],
      });
      await access.updateRole({
        scope: SHOP,
        actorUserId: owner,
        roleId: helper.id,
        permissions: ['stock:view'],
      });
      // Someone still holding the first version saves over it.
      expect(
        await errorOf(() =>
          storage.unitOfWork.tenant(SHOP, () =>
            storage.roles.update({ ...helper, name: 'Late change' }),
          ),
        ),
      ).toBe(IDENTITY_ERRORS.CHANGED_MEANWHILE);
    });
  });
});
