import {
  ALL_PERMISSIONS,
  SYSTEM_ROLE_KEYS,
  defaultPermissionsOf,
  type SystemRoleKey,
} from '@hk/contracts/permissions';
import { IDENTITY_ERRORS, type Role } from '@hk/core/identity/domain';
import { sequentialIds } from '@hk/platform/test-kit';
import { FixedClock, isDomainError } from '@hk/platform/universal';
import {
  ACCESS_USE_CASES,
  createAccess,
  type AccessService,
  type Acting,
} from './access';
import { createAccessAudit } from './access-audit';
import {
  membershipDirectoryConformance,
  membershipRepositoryConformance,
  roleRepositoryConformance,
} from './access-conformance';
import {
  createInMemoryIdentityStore,
  type InMemoryIdentityStore,
} from './in-memory';
import {
  createFixedEntitlements,
  createInMemoryAccessStore,
  createRecordingAccessAudit,
  type InMemoryAccessStore,
} from './in-memory-access';
import type { BusinessScope } from './ports';

// Every name, phone number and id in this file is invented.

const START = '2026-11-28T09:00:00.000Z';
const TENANT = '018f0000-0000-7000-8000-00000000f001';
const SHOP: BusinessScope = {
  tenantId: TENANT,
  businessId: '018f0000-0000-7000-8000-00000000b001',
};
const DEPOT: BusinessScope = {
  tenantId: TENANT,
  businessId: '018f0000-0000-7000-8000-00000000b002',
};
const BRANCH_1 = '018f0000-0000-7000-8000-00000000bb01';
const BRANCH_2 = '018f0000-0000-7000-8000-00000000bb02';

const failure = async (action: () => Promise<unknown>) => {
  try {
    await action();
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error('nothing was thrown');
};

const codeOf = async (action: () => Promise<unknown>): Promise<string> =>
  (await failure(action)).code;

describe('access', () => {
  let people: InMemoryIdentityStore;
  let store: InMemoryAccessStore;
  let entitlements: ReturnType<typeof createFixedEntitlements>;
  let audit: ReturnType<typeof createRecordingAccessAudit>;
  let clock: FixedClock;
  let access: AccessService;
  let newId: () => string;
  let owner: string;
  let userCount: number;

  /** An account that may sign in. */
  const person = async (name: string): Promise<string> => {
    userCount += 1;
    const phone = {
      kind: 'phone',
      value: `+2376000000${String(userCount).padStart(2, '0')}`,
    } as const;
    const created = await people.users.create({
      id: newId(),
      name,
      locale: 'en',
      identifiers: [phone],
      passwordHash: null,
      createdAt: START,
    });
    await people.users.markIdentifierVerified(created.id, phone, START);
    return created.id;
  };

  const as = (actorUserId: string, scope: BusinessScope = SHOP): Acting => ({
    scope,
    actorUserId,
  });

  const roleByKey = async (
    key: SystemRoleKey,
    scope: BusinessScope = SHOP,
  ): Promise<Role> =>
    (await store.unitOfWork.tenant(scope, () =>
      store.roles.findByKey(key),
    )) as Role;

  /** Adds a new person to the shop with a built-in role. Returns their ids. */
  const member = async (
    name: string,
    key: SystemRoleKey,
    branchIds: readonly string[] | null = null,
  ): Promise<{ userId: string; membershipId: string }> => {
    const userId = await person(name);
    const membership = await access.addMember({
      ...as(owner),
      userId,
      roleId: (await roleByKey(key)).id,
      branchIds,
    });
    return { userId, membershipId: membership.id };
  };

  /** A custom role made by the owner, held by a new person. */
  const memberWithCustomRole = async (
    name: string,
    permissions: readonly string[],
  ) => {
    const role = await access.createRole({ ...as(owner), name, permissions });
    const userId = await person(name);
    const membership = await access.addMember({
      ...as(owner),
      userId,
      roleId: role.id,
    });
    return { userId, membershipId: membership.id, role };
  };

  beforeEach(async () => {
    people = createInMemoryIdentityStore();
    store = createInMemoryAccessStore();
    entitlements = createFixedEntitlements([
      'accounting',
      'sales',
      'inventory',
      'pos',
      'payroll',
    ]);
    audit = createRecordingAccessAudit();
    clock = new FixedClock(START);
    newId = sequentialIds(6);
    userCount = 0;
    access = createAccess({
      users: people.users,
      roles: store.roles,
      memberships: store.memberships,
      directory: store.directory,
      unitOfWork: store.unitOfWork,
      entitlements,
      audit,
      clock,
      newId,
    });
    owner = await person('Ada Owner');
    await access.provisionBusiness({ scope: SHOP, ownerUserId: owner });
  });

  it('declares that no access use case runs offline', () => {
    for (const useCase of Object.values(ACCESS_USE_CASES)) {
      expect(useCase.offline).toBe(false);
      expect(useCase.name).toMatch(/^core\.identity\.[a-z_]+$/);
    }
    expect(Object.keys(ACCESS_USE_CASES)).toHaveLength(14);
  });

  describe('provisioning a business', () => {
    it('gives it every built-in role with its default permissions', async () => {
      const roles = await access.listRoles(as(owner));
      expect(roles.map((role) => role.key)).toEqual([...SYSTEM_ROLE_KEYS]);
      for (const role of roles) {
        expect(role.permissions).toEqual(
          role.key === 'owner'
            ? []
            : defaultPermissionsOf(role.key as SystemRoleKey),
        );
      }
    });

    it('makes the person its owner, in every branch', async () => {
      const [only] = await access.listMembers(as(owner));
      expect(only).toEqual({
        id: expect.any(String),
        userId: owner,
        name: 'Ada Owner',
        role: { id: expect.any(String), key: 'owner', name: 'Owner' },
        branchIds: null,
        status: 'active',
        joinedAt: START,
      });
      expect(await access.listBusinesses({ userId: owner })).toEqual([SHOP]);
    });

    it('can be run again and changes nothing', async () => {
      const before = await access.listRoles(as(owner));
      await access.provisionBusiness({ scope: SHOP, ownerUserId: owner });
      expect(await access.listRoles(as(owner))).toEqual(before);
      expect(await access.listMembers(as(owner))).toHaveLength(1);
    });

    it('restores a built-in role that went missing, and keeps edited ones', async () => {
      const cashier = await roleByKey('cashier');
      await access.updateRole({
        ...as(owner),
        roleId: cashier.id,
        permissions: ['invoices:view'],
      });
      const viewer = await roleByKey('viewer');
      await store.unitOfWork.tenant(SHOP, () => store.roles.remove(viewer.id));
      await access.provisionBusiness({ scope: SHOP, ownerUserId: owner });
      expect((await roleByKey('cashier')).permissions).toEqual([
        'invoices:view',
      ]);
      expect((await roleByKey('viewer')).permissions).toEqual(
        defaultPermissionsOf('viewer'),
      );
    });

    it('never gives a business a second owner, or replaces the first', async () => {
      const other = await person('Ben Other');
      const error = await failure(() =>
        access.provisionBusiness({ scope: SHOP, ownerUserId: other }),
      );
      expect(error.code).toBe(IDENTITY_ERRORS.OWNER_PROTECTED);
      expect(await access.listBusinesses({ userId: other })).toEqual([]);
    });

    it('refuses to make an existing member the owner', async () => {
      const { userId } = await member('Cy Cashier', 'cashier');
      // The owner leaves no owner behind only if storage is tampered with;
      // provisioning must still not promote a member silently.
      const ownerRole = await roleByKey('owner');
      await store.unitOfWork.tenant(SHOP, async () => {
        const mine = await store.memberships.findByUser(owner);
        if (mine) {
          await store.memberships.update({ ...mine, status: 'removed' });
        }
        expect(await store.memberships.countWithRole(ownerRole.id)).toBe(0);
      });
      expect(
        await codeOf(() =>
          access.provisionBusiness({ scope: SHOP, ownerUserId: userId }),
        ),
      ).toBe(IDENTITY_ERRORS.MEMBER_EXISTS);
    });

    it('keeps two businesses’ roles and owners apart', async () => {
      const other = await person('Dee Depot');
      await access.provisionBusiness({ scope: DEPOT, ownerUserId: other });
      expect(await access.listMembers(as(other, DEPOT))).toHaveLength(1);
      expect(await codeOf(() => access.listMembers(as(owner, DEPOT)))).toBe(
        IDENTITY_ERRORS.ACCESS_DENIED,
      );
      expect((await roleByKey('owner')).id).not.toBe(
        (await roleByKey('owner', DEPOT)).id,
      );
    });
  });

  describe('authorizing a request', () => {
    it('gives the owner every permission of the products the business has', async () => {
      const result = await access.authorize({
        userId: owner,
        businessId: SHOP.businessId,
      });
      expect(result).toEqual({
        userId: owner,
        tenantId: SHOP.tenantId,
        businessId: SHOP.businessId,
        membershipId: expect.any(String),
        roleId: (await roleByKey('owner')).id,
        roleKey: 'owner',
        isOwner: true,
        branchIds: null,
        branchId: null,
        permissions: [...ALL_PERMISSIONS],
      });
    });

    it('drops the permissions of a product the business does not have', async () => {
      entitlements.set(SHOP, ['sales']);
      const { permissions } = await access.authorize({
        userId: owner,
        businessId: SHOP.businessId,
      });
      expect(permissions).toContain('invoices:void');
      expect(permissions).toContain('roles:manage');
      expect(permissions.some((item) => item.startsWith('payroll_runs:'))).toBe(
        false,
      );
      expect(permissions.some((item) => item.startsWith('stock:'))).toBe(false);
    });

    it('gives a member what their role grants', async () => {
      const { userId } = await member('Cy Cashier', 'cashier');
      const result = await access.authorize({
        userId,
        businessId: SHOP.businessId,
      });
      expect(result).toMatchObject({ roleKey: 'cashier', isOwner: false });
      expect(result.permissions).toEqual(defaultPermissionsOf('cashier'));
    });

    it('follows a change to the role at once', async () => {
      const { userId } = await member('Cy Cashier', 'cashier');
      await access.updateRole({
        ...as(owner),
        roleId: (await roleByKey('cashier')).id,
        permissions: ['invoices:view'],
      });
      expect(
        (await access.authorize({ userId, businessId: SHOP.businessId }))
          .permissions,
      ).toEqual(['invoices:view']);
    });

    it('lets a member limited to a branch into that branch only', async () => {
      const { userId } = await member('Cy Cashier', 'cashier', [BRANCH_1]);
      const allowed = await access.authorize({
        userId,
        businessId: SHOP.businessId,
        branchId: BRANCH_1,
      });
      expect(allowed).toMatchObject({
        branchId: BRANCH_1,
        branchIds: [BRANCH_1],
      });
      const error = await failure(() =>
        access.authorize({
          userId,
          businessId: SHOP.businessId,
          branchId: BRANCH_2,
        }),
      );
      expect(error.code).toBe(IDENTITY_ERRORS.BRANCH_DENIED);
      expect(error.kind).toBe('forbidden');
      // With no branch named, the request is for the business as a whole.
      expect(
        (await access.authorize({ userId, businessId: SHOP.businessId }))
          .branchId,
      ).toBeNull();
    });

    it('lets a member of every branch into any branch', async () => {
      const result = await access.authorize({
        userId: owner,
        businessId: SHOP.businessId,
        branchId: BRANCH_2,
      });
      expect(result.branchId).toBe(BRANCH_2);
    });

    it.each<[string, () => Promise<{ userId: string; businessId: string }>]>([
      [
        'a stranger',
        async () => ({
          userId: await person('Sam Stranger'),
          businessId: SHOP.businessId,
        }),
      ],
      [
        'a suspended member',
        async () => {
          const added = await member('Cy Cashier', 'cashier');
          await access.suspendMember({
            ...as(owner),
            membershipId: added.membershipId,
          });
          return { userId: added.userId, businessId: SHOP.businessId };
        },
      ],
      [
        'a removed member',
        async () => {
          const added = await member('Cy Cashier', 'cashier');
          await access.removeMember({
            ...as(owner),
            membershipId: added.membershipId,
          });
          return { userId: added.userId, businessId: SHOP.businessId };
        },
      ],
      [
        'a member whose account is suspended',
        async () => {
          const added = await member('Cy Cashier', 'cashier');
          people.users.setStatus(added.userId, 'suspended');
          return { userId: added.userId, businessId: SHOP.businessId };
        },
      ],
      [
        'a business that does not exist',
        async () => ({
          userId: owner,
          businessId: '018f0000-0000-7000-8000-00000000dead',
        }),
      ],
      [
        'a member of one business asking for another',
        async () => {
          await access.provisionBusiness({
            scope: DEPOT,
            ownerUserId: await person('Dee Depot'),
          });
          return { userId: owner, businessId: DEPOT.businessId };
        },
      ],
      [
        'an account that does not exist',
        async () => ({ userId: 'no-such-user', businessId: SHOP.businessId }),
      ],
    ])('refuses %s, with the one answer', async (_name, arrange) => {
      const input = await arrange();
      const error = await failure(() => access.authorize(input));
      expect(error.code).toBe(IDENTITY_ERRORS.ACCESS_DENIED);
      expect(error.kind).toBe('forbidden');
      expect(error.message).toBe('You do not have access to do this.');
      expect(error.details).toEqual({});
    });

    it('fails closed when the directory says yes and the membership says no', async () => {
      // The directory is only a pointer. If the two ever disagreed, the
      // membership inside the business is what counts.
      const { userId, membershipId } = await member('Cy Cashier', 'cashier');
      await store.unitOfWork.tenant(SHOP, async () => {
        const mine = await store.memberships.findById(membershipId);
        if (mine)
          await store.memberships.update({ ...mine, status: 'removed' });
      });
      expect(await access.listBusinesses({ userId })).toEqual([SHOP]);
      expect(
        await codeOf(() =>
          access.authorize({ userId, businessId: SHOP.businessId }),
        ),
      ).toBe(IDENTITY_ERRORS.ACCESS_DENIED);
    });

    it('fails closed for a member whose role no longer exists', async () => {
      const { userId, role } = await memberWithCustomRole('Auditor', [
        'accounts:view',
      ]);
      await store.unitOfWork.tenant(SHOP, () => store.roles.remove(role.id));
      expect(
        await codeOf(() =>
          access.authorize({ userId, businessId: SHOP.businessId }),
        ),
      ).toBe(IDENTITY_ERRORS.ACCESS_DENIED);
    });
  });

  describe('listing a person’s businesses', () => {
    it('lists the ones they may enter now', async () => {
      const cy = await person('Cy Cashier');
      await access.provisionBusiness({ scope: DEPOT, ownerUserId: cy });
      const added = await access.addMember({
        ...as(owner),
        userId: cy,
        roleId: (await roleByKey('cashier')).id,
      });
      expect(await access.listBusinesses({ userId: cy })).toEqual([
        SHOP,
        DEPOT,
      ]);

      await access.suspendMember({ ...as(owner), membershipId: added.id });
      expect(await access.listBusinesses({ userId: cy })).toEqual([DEPOT]);
      await access.reinstateMember({ ...as(owner), membershipId: added.id });
      expect(await access.listBusinesses({ userId: cy })).toEqual([
        SHOP,
        DEPOT,
      ]);
      await access.removeMember({ ...as(owner), membershipId: added.id });
      expect(await access.listBusinesses({ userId: cy })).toEqual([DEPOT]);
    });

    it('is empty for someone who belongs nowhere', async () => {
      expect(
        await access.listBusinesses({ userId: await person('Sam Stranger') }),
      ).toEqual([]);
    });
  });

  describe('roles', () => {
    it('are shown to those who may see them', async () => {
      const manager = await member('Mo Manager', 'manager');
      const cashier = await member('Cy Cashier', 'cashier');
      expect(await access.listRoles(as(manager.userId))).toHaveLength(8);
      expect(await codeOf(() => access.listRoles(as(cashier.userId)))).toBe(
        IDENTITY_ERRORS.ACCESS_DENIED,
      );
    });

    it('can be created by the owner', async () => {
      const role = await access.createRole({
        ...as(owner),
        name: '  Shift   lead ',
        permissions: ['stock:view', 'invoices:view', 'invoices:view'],
      });
      expect(role).toEqual({
        id: expect.any(String),
        key: null,
        name: 'Shift lead',
        permissions: ['invoices:view', 'stock:view'],
        version: 1,
      });
      expect((await access.listRoles(as(owner))).at(-1)).toEqual(role);
    });

    it.each<[string, { name: string; permissions: readonly string[] }, string]>(
      [
        [
          'a name already used, whatever its case',
          { name: 'cashier', permissions: [] },
          IDENTITY_ERRORS.ROLE_NAME_TAKEN,
        ],
        [
          'a one-letter name',
          { name: 'X', permissions: [] },
          IDENTITY_ERRORS.ROLE_NAME_INVALID,
        ],
        [
          'a permission that does not exist',
          { name: 'Odd', permissions: ['stock:teleport'] },
          IDENTITY_ERRORS.ROLE_PERMISSION_UNKNOWN,
        ],
      ],
    )('refuses to create a role with %s', async (_name, input, code) => {
      expect(
        await codeOf(() => access.createRole({ ...as(owner), ...input })),
      ).toBe(code);
      expect(await access.listRoles(as(owner))).toHaveLength(8);
    });

    it('stops at fifty roles', async () => {
      for (let n = 9; n <= 50; n += 1) {
        await access.createRole({
          ...as(owner),
          name: `Role ${n}`,
          permissions: [],
        });
      }
      const error = await failure(() =>
        access.createRole({ ...as(owner), name: 'One more', permissions: [] }),
      );
      expect(error.code).toBe(IDENTITY_ERRORS.ROLE_LIMIT);
      expect(error.details).toEqual({ max: 50 });
    });

    it('cannot be managed by a manager, by default', async () => {
      const manager = await member('Mo Manager', 'manager');
      expect(
        await codeOf(() =>
          access.createRole({
            ...as(manager.userId),
            name: 'Helper',
            permissions: [],
          }),
        ),
      ).toBe(IDENTITY_ERRORS.ACCESS_DENIED);
    });

    it('lets nobody create a role that grants more than they hold', async () => {
      const lead = await memberWithCustomRole('Role admin', [
        'roles:view',
        'roles:manage',
        'stock:view',
      ]);
      const error = await failure(() =>
        access.createRole({
          ...as(lead.userId),
          name: 'Everything',
          permissions: ['stock:view', 'stock:adjust', 'members:remove'],
        }),
      );
      expect(error.code).toBe(IDENTITY_ERRORS.PERMISSION_EXCEEDS_OWN);
      expect(error.kind).toBe('forbidden');
      expect(error.details).toEqual({ permissions: 2 });
      // Within their own access, they may.
      const allowed = await access.createRole({
        ...as(lead.userId),
        name: 'Stock watcher',
        permissions: ['stock:view'],
      });
      expect(allowed.permissions).toEqual(['stock:view']);
    });

    it('lets the owner change what a built-in role may do, but not its name', async () => {
      const cashier = await roleByKey('cashier');
      const updated = await access.updateRole({
        ...as(owner),
        roleId: cashier.id,
        permissions: ['invoices:view', 'pos_sessions:refund'],
      });
      expect(updated).toMatchObject({
        key: 'cashier',
        name: 'Cashier',
        permissions: ['invoices:view', 'pos_sessions:refund'],
        version: 2,
      });
      expect(
        await codeOf(() =>
          access.updateRole({ ...as(owner), roleId: cashier.id, name: 'Till' }),
        ),
      ).toBe(IDENTITY_ERRORS.ROLE_LOCKED);
    });

    it('lets a custom role be renamed, but not onto another role’s name', async () => {
      const role = await access.createRole({
        ...as(owner),
        name: 'Helper',
        permissions: [],
      });
      expect(
        (
          await access.updateRole({
            ...as(owner),
            roleId: role.id,
            name: 'Assistant',
          })
        ).name,
      ).toBe('Assistant');
      expect(
        await codeOf(() =>
          access.updateRole({ ...as(owner), roleId: role.id, name: 'MANAGER' }),
        ),
      ).toBe(IDENTITY_ERRORS.ROLE_NAME_TAKEN);
      // Keeping its own name is not a clash.
      expect(
        (
          await access.updateRole({
            ...as(owner),
            roleId: role.id,
            name: 'assistant',
          })
        ).name,
      ).toBe('assistant');
    });

    it('never lets the owner role be changed, even by the owner', async () => {
      const ownerRole = await roleByKey('owner');
      for (const change of [{ permissions: [] }, { name: 'Boss' }]) {
        expect(
          await codeOf(() =>
            access.updateRole({
              ...as(owner),
              roleId: ownerRole.id,
              ...change,
            }),
          ),
        ).toBe(IDENTITY_ERRORS.ROLE_LOCKED);
      }
    });

    it('lets nobody rewrite a role more powerful than their own', async () => {
      const lead = await memberWithCustomRole('Role admin', [
        'roles:view',
        'roles:manage',
      ]);
      const manager = await roleByKey('manager');
      // Stripping the manager role would be as much a seizure of power as
      // widening one's own.
      expect(
        await codeOf(() =>
          access.updateRole({
            ...as(lead.userId),
            roleId: manager.id,
            permissions: [],
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PERMISSION_EXCEEDS_OWN);
      // Nor may they widen their own role.
      expect(
        await codeOf(() =>
          access.updateRole({
            ...as(lead.userId),
            roleId: lead.role.id,
            permissions: ['roles:view', 'roles:manage', 'members:remove'],
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PERMISSION_EXCEEDS_OWN);
      expect((await roleByKey('manager')).permissions).toEqual(
        defaultPermissionsOf('manager'),
      );
    });

    it('deletes a custom role nobody holds, and only that', async () => {
      const held = await memberWithCustomRole('Auditor', ['accounts:view']);
      const inUse = await failure(() =>
        access.deleteRole({ ...as(owner), roleId: held.role.id }),
      );
      expect(inUse.code).toBe(IDENTITY_ERRORS.ROLE_IN_USE);
      expect(inUse.details).toEqual({ members: 1 });

      expect(
        await codeOf(async () =>
          access.deleteRole({
            ...as(owner),
            roleId: (await roleByKey('viewer')).id,
          }),
        ),
      ).toBe(IDENTITY_ERRORS.ROLE_LOCKED);
      expect(
        await codeOf(() =>
          access.deleteRole({ ...as(owner), roleId: 'no-such-role' }),
        ),
      ).toBe(IDENTITY_ERRORS.ROLE_NOT_FOUND);

      await access.removeMember({
        ...as(owner),
        membershipId: held.membershipId,
      });
      await access.deleteRole({ ...as(owner), roleId: held.role.id });
      expect(await access.listRoles(as(owner))).toHaveLength(8);
    });
  });

  describe('members', () => {
    it('are added by the owner, with a role and branches', async () => {
      const userId = await person('Cy Cashier');
      const cashier = await roleByKey('cashier');
      const membership = await access.addMember({
        ...as(owner),
        userId,
        roleId: cashier.id,
        branchIds: [BRANCH_2, BRANCH_1],
      });
      expect(membership).toEqual({
        id: expect.any(String),
        userId,
        roleId: cashier.id,
        branchIds: [BRANCH_1, BRANCH_2],
        status: 'active',
        joinedAt: START,
        version: 1,
      });
      expect(await access.listBusinesses({ userId })).toEqual([SHOP]);
    });

    it.each<
      [
        string,
        () => Promise<
          Partial<{
            userId: string;
            roleId: string;
            branchIds: readonly string[];
          }>
        >,
        string,
      ]
    >([
      [
        'someone who is already a member',
        async () => ({ userId: owner }),
        IDENTITY_ERRORS.MEMBER_EXISTS,
      ],
      [
        'an account that does not exist',
        async () => ({ userId: 'no-such-user' }),
        IDENTITY_ERRORS.USER_NOT_FOUND,
      ],
      [
        'a role that does not exist',
        async () => ({ roleId: 'no-such-role' }),
        IDENTITY_ERRORS.ROLE_NOT_FOUND,
      ],
      [
        'the owner role',
        async () => ({ roleId: (await roleByKey('owner')).id }),
        IDENTITY_ERRORS.OWNER_PROTECTED,
      ],
      [
        'an empty list of branches',
        async () => ({ branchIds: [] }),
        IDENTITY_ERRORS.BRANCH_SCOPE_INVALID,
      ],
    ])('refuses to add %s', async (_name, arrange, code) => {
      const userId = await person('New Person');
      const overrides = await arrange();
      expect(
        await codeOf(async () =>
          access.addMember({
            ...as(owner),
            userId,
            roleId: (await roleByKey('cashier')).id,
            ...overrides,
          }),
        ),
      ).toBe(code);
    });

    it('refuses to add an account that has not verified anything', async () => {
      const pending = await people.users.create({
        id: newId(),
        name: 'Pat Pending',
        locale: 'en',
        identifiers: [{ kind: 'phone', value: '+237600000099' }],
        passwordHash: null,
        createdAt: START,
      });
      expect(
        await codeOf(async () =>
          access.addMember({
            ...as(owner),
            userId: pending.id,
            roleId: (await roleByKey('cashier')).id,
          }),
        ),
      ).toBe(IDENTITY_ERRORS.USER_NOT_FOUND);
    });

    it('cannot be added by someone without the permission', async () => {
      const manager = await member('Mo Manager', 'manager');
      const userId = await person('New Person');
      expect(
        await codeOf(async () =>
          access.addMember({
            ...as(manager.userId),
            userId,
            roleId: (await roleByKey('cashier')).id,
          }),
        ),
      ).toBe(IDENTITY_ERRORS.ACCESS_DENIED);
    });

    it('cannot be given a role greater than the one who adds them', async () => {
      const recruiter = await memberWithCustomRole('Recruiter', [
        'members:view',
        'members:invite',
        'invoices:view',
      ]);
      const userId = await person('New Person');
      expect(
        await codeOf(async () =>
          access.addMember({
            ...as(recruiter.userId),
            userId,
            roleId: (await roleByKey('manager')).id,
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PERMISSION_EXCEEDS_OWN);
      const helper = await access.createRole({
        ...as(owner),
        name: 'Helper',
        permissions: ['invoices:view'],
      });
      const added = await access.addMember({
        ...as(recruiter.userId),
        userId,
        roleId: helper.id,
      });
      expect(added.roleId).toBe(helper.id);
    });

    it('come back as the same membership when added again after removal', async () => {
      const cy = await member('Cy Cashier', 'cashier', [BRANCH_1]);
      await access.removeMember({
        ...as(owner),
        membershipId: cy.membershipId,
      });
      clock.advance(86_400_000);
      const again = await access.addMember({
        ...as(owner),
        userId: cy.userId,
        roleId: (await roleByKey('storekeeper')).id,
      });
      expect(again).toMatchObject({
        id: cy.membershipId,
        status: 'active',
        branchIds: null,
        joinedAt: '2026-11-29T09:00:00.000Z',
      });
      expect(
        (
          await access.authorize({
            userId: cy.userId,
            businessId: SHOP.businessId,
          })
        ).roleKey,
      ).toBe('storekeeper');
    });

    it('are listed with their names and roles, without the removed', async () => {
      const cy = await member('Cy Cashier', 'cashier', [BRANCH_1]);
      const gone = await member('Gil Gone', 'viewer');
      await access.removeMember({
        ...as(owner),
        membershipId: gone.membershipId,
      });
      await access.suspendMember({
        ...as(owner),
        membershipId: cy.membershipId,
      });
      const listed = await access.listMembers(as(owner));
      expect(
        listed.map((item) => [item.name, item.role?.key, item.status]),
      ).toEqual([
        ['Ada Owner', 'owner', 'active'],
        ['Cy Cashier', 'cashier', 'suspended'],
      ]);
      expect(listed[1]?.branchIds).toEqual([BRANCH_1]);
    });

    it('are shown only to those who may see them', async () => {
      const cashier = await member('Cy Cashier', 'cashier');
      const manager = await member('Mo Manager', 'manager');
      expect(await codeOf(() => access.listMembers(as(cashier.userId)))).toBe(
        IDENTITY_ERRORS.ACCESS_DENIED,
      );
      expect(await access.listMembers(as(manager.userId))).toHaveLength(3);
    });

    it('can have their role changed', async () => {
      const cy = await member('Cy Cashier', 'cashier');
      const changed = await access.changeMemberRole({
        ...as(owner),
        membershipId: cy.membershipId,
        roleId: (await roleByKey('storekeeper')).id,
      });
      expect(changed.version).toBe(2);
      expect(
        (
          await access.authorize({
            userId: cy.userId,
            businessId: SHOP.businessId,
          })
        ).permissions,
      ).toEqual(defaultPermissionsOf('storekeeper'));
    });

    it('cannot be made owner by a change of role', async () => {
      const cy = await member('Cy Cashier', 'cashier');
      expect(
        await codeOf(async () =>
          access.changeMemberRole({
            ...as(owner),
            membershipId: cy.membershipId,
            roleId: (await roleByKey('owner')).id,
          }),
        ),
      ).toBe(IDENTITY_ERRORS.OWNER_PROTECTED);
    });

    it('can have their branches changed, back to every branch too', async () => {
      const cy = await member('Cy Cashier', 'cashier', [BRANCH_1]);
      const moved = await access.setMemberBranches({
        ...as(owner),
        membershipId: cy.membershipId,
        branchIds: [BRANCH_2],
      });
      expect(moved.branchIds).toEqual([BRANCH_2]);
      expect(
        await codeOf(() =>
          access.authorize({
            userId: cy.userId,
            businessId: SHOP.businessId,
            branchId: BRANCH_1,
          }),
        ),
      ).toBe(IDENTITY_ERRORS.BRANCH_DENIED);
      const everywhere = await access.setMemberBranches({
        ...as(owner),
        membershipId: cy.membershipId,
        branchIds: null,
      });
      expect(everywhere.branchIds).toBeNull();
      expect(
        await codeOf(() =>
          access.setMemberBranches({
            ...as(owner),
            membershipId: cy.membershipId,
            branchIds: [],
          }),
        ),
      ).toBe(IDENTITY_ERRORS.BRANCH_SCOPE_INVALID);
    });

    it('lose access at once when suspended, and get it back when reinstated', async () => {
      const cy = await member('Cy Cashier', 'cashier');
      const input = { userId: cy.userId, businessId: SHOP.businessId };
      await access.suspendMember({
        ...as(owner),
        membershipId: cy.membershipId,
      });
      expect(await codeOf(() => access.authorize(input))).toBe(
        IDENTITY_ERRORS.ACCESS_DENIED,
      );
      // Suspending again changes nothing, and is not an error.
      const again = await access.suspendMember({
        ...as(owner),
        membershipId: cy.membershipId,
      });
      expect(again.version).toBe(2);
      await access.reinstateMember({
        ...as(owner),
        membershipId: cy.membershipId,
      });
      expect((await access.authorize(input)).roleKey).toBe('cashier');
    });

    it('cannot be changed once removed', async () => {
      const cy = await member('Cy Cashier', 'cashier');
      await access.removeMember({
        ...as(owner),
        membershipId: cy.membershipId,
      });
      for (const attempt of [
        () =>
          access.suspendMember({ ...as(owner), membershipId: cy.membershipId }),
        () =>
          access.reinstateMember({
            ...as(owner),
            membershipId: cy.membershipId,
          }),
        () =>
          access.removeMember({ ...as(owner), membershipId: cy.membershipId }),
        () =>
          access.removeMember({ ...as(owner), membershipId: 'no-such-member' }),
      ]) {
        expect(await codeOf(attempt)).toBe(IDENTITY_ERRORS.MEMBER_NOT_FOUND);
      }
    });
  });

  describe('protections', () => {
    it('never lets the owner’s membership be changed, by anyone', async () => {
      const ownerMembership = (await access.listMembers(as(owner)))[0]
        ?.id as string;
      const admin = await memberWithCustomRole('People admin', [
        ...ALL_PERMISSIONS,
      ]);
      const cashierRole = await roleByKey('cashier');
      for (const actor of [owner, admin.userId]) {
        for (const attempt of [
          () =>
            access.removeMember({
              ...as(actor),
              membershipId: ownerMembership,
            }),
          () =>
            access.suspendMember({
              ...as(actor),
              membershipId: ownerMembership,
            }),
          () =>
            access.changeMemberRole({
              ...as(actor),
              membershipId: ownerMembership,
              roleId: cashierRole.id,
            }),
          () =>
            access.setMemberBranches({
              ...as(actor),
              membershipId: ownerMembership,
              branchIds: [BRANCH_1],
            }),
        ]) {
          expect(await codeOf(attempt)).toBe(IDENTITY_ERRORS.OWNER_PROTECTED);
        }
      }
      expect(
        (await access.authorize({ userId: owner, businessId: SHOP.businessId }))
          .isOwner,
      ).toBe(true);
    });

    it('never lets a member change their own membership', async () => {
      const admin = await memberWithCustomRole('People admin', [
        ...ALL_PERMISSIONS,
      ]);
      const managerRole = await roleByKey('manager');
      for (const attempt of [
        () =>
          access.removeMember({
            ...as(admin.userId),
            membershipId: admin.membershipId,
          }),
        () =>
          access.suspendMember({
            ...as(admin.userId),
            membershipId: admin.membershipId,
          }),
        () =>
          access.changeMemberRole({
            ...as(admin.userId),
            membershipId: admin.membershipId,
            roleId: managerRole.id,
          }),
        () =>
          access.setMemberBranches({
            ...as(admin.userId),
            membershipId: admin.membershipId,
            branchIds: null,
          }),
      ]) {
        expect(await codeOf(attempt)).toBe(
          IDENTITY_ERRORS.SELF_CHANGE_FORBIDDEN,
        );
      }
    });

    it('never lets a member act on someone with more access than their own', async () => {
      const junior = await memberWithCustomRole('Junior admin', [
        'members:view',
        'members:update',
        'members:remove',
        'invoices:view',
      ]);
      const manager = await member('Mo Manager', 'manager');
      const viewerRole = await roleByKey('viewer');
      for (const attempt of [
        () =>
          access.removeMember({
            ...as(junior.userId),
            membershipId: manager.membershipId,
          }),
        () =>
          access.suspendMember({
            ...as(junior.userId),
            membershipId: manager.membershipId,
          }),
        () =>
          access.changeMemberRole({
            ...as(junior.userId),
            membershipId: manager.membershipId,
            roleId: viewerRole.id,
          }),
      ]) {
        expect(await codeOf(attempt)).toBe(
          IDENTITY_ERRORS.PERMISSION_EXCEEDS_OWN,
        );
      }
      // Someone within their own access, they may act on.
      const helper = await memberWithCustomRole('Helper', ['invoices:view']);
      const suspended = await access.suspendMember({
        ...as(junior.userId),
        membershipId: helper.membershipId,
      });
      expect(suspended.status).toBe('suspended');
    });

    it('gives a suspended or removed member no say at all', async () => {
      const manager = await member('Mo Manager', 'manager');
      await access.suspendMember({
        ...as(owner),
        membershipId: manager.membershipId,
      });
      expect(await codeOf(() => access.listMembers(as(manager.userId)))).toBe(
        IDENTITY_ERRORS.ACCESS_DENIED,
      );
      expect(await codeOf(() => access.listRoles(as(manager.userId)))).toBe(
        IDENTITY_ERRORS.ACCESS_DENIED,
      );
    });

    it('does not let one business’s owner manage another business', async () => {
      const other = await person('Dee Depot');
      await access.provisionBusiness({ scope: DEPOT, ownerUserId: other });
      const theirs = (await access.listMembers(as(other, DEPOT)))[0]
        ?.id as string;
      for (const attempt of [
        () => access.listRoles(as(owner, DEPOT)),
        () =>
          access.createRole({
            ...as(owner, DEPOT),
            name: 'Mine',
            permissions: [],
          }),
        () =>
          access.removeMember({ ...as(owner, DEPOT), membershipId: theirs }),
      ]) {
        expect(await codeOf(attempt)).toBe(IDENTITY_ERRORS.ACCESS_DENIED);
      }
      // And a membership id from another business is simply not found here.
      expect(
        await codeOf(() =>
          access.removeMember({ ...as(owner), membershipId: theirs }),
        ),
      ).toBe(IDENTITY_ERRORS.MEMBER_NOT_FOUND);
    });
  });

  describe('keeping the record straight', () => {
    it('adds nobody when any part of adding them fails', async () => {
      const userId = await person('Cy Cashier');
      const failing = createAccess({
        users: people.users,
        roles: store.roles,
        memberships: store.memberships,
        directory: store.directory,
        unitOfWork: store.unitOfWork,
        entitlements,
        audit: {
          record: async () => {
            throw new Error('the audit log is down');
          },
        },
        clock,
        newId,
      });
      await expect(
        failing.addMember({
          ...as(owner),
          userId,
          roleId: (await roleByKey('cashier')).id,
        }),
      ).rejects.toThrow('the audit log is down');
      // No membership, no line in the directory, no access.
      expect(await access.listMembers(as(owner))).toHaveLength(1);
      expect(await access.listBusinesses({ userId })).toEqual([]);
    });

    it('records each change, with ids and permission names only', async () => {
      audit.events.length = 0;
      const cy = await member('Cy Cashier', 'cashier');
      const role = await access.createRole({
        ...as(owner),
        name: 'Helper',
        permissions: ['invoices:view'],
      });
      await access.changeMemberRole({
        ...as(owner),
        membershipId: cy.membershipId,
        roleId: role.id,
      });
      await access.removeMember({
        ...as(owner),
        membershipId: cy.membershipId,
      });
      await access.deleteRole({ ...as(owner), roleId: role.id });

      expect(
        audit.events.map((event) => [event.entityType, event.action]),
      ).toEqual([
        ['core.membership', 'create'],
        ['core.role', 'create'],
        ['core.membership', 'update'],
        ['core.membership', 'delete'],
        ['core.role', 'delete'],
      ]);
      expect(audit.events.every((event) => event.actorUserId === owner)).toBe(
        true,
      );
      expect(audit.events.every((event) => event.scope === SHOP)).toBe(true);
      const text = JSON.stringify(audit.events);
      expect(text).not.toContain('Cy Cashier');
      expect(text).not.toContain('Helper');
      expect(text).not.toMatch(/\+237/);
    });

    it('works with no audit sink at all', async () => {
      const quiet = createAccess({
        users: people.users,
        roles: store.roles,
        memberships: store.memberships,
        directory: store.directory,
        unitOfWork: store.unitOfWork,
        entitlements,
        clock,
        newId,
      });
      const role = await quiet.createRole({
        ...as(owner),
        name: 'Helper',
        permissions: [],
      });
      expect(role.name).toBe('Helper');
    });
  });
});

describe('createAccessAudit', () => {
  it('passes a change to the audit log as the acting user', async () => {
    const recorded: unknown[] = [];
    const audit = createAccessAudit({
      record: async (scope, input) => {
        recorded.push({ scope, input });
        return {} as never;
      },
    });
    await audit.record(SHOP, {
      actorUserId: 'user-1',
      action: 'update',
      entityType: 'core.membership',
      entityId: 'membership-1',
      details: { change: 'suspend', status: 'suspended' },
    });
    await audit.record(SHOP, {
      actorUserId: null,
      action: 'create',
      entityType: 'core.role',
      entityId: 'role-1',
      details: { permissions: ['stock:view'] },
    });
    expect(recorded).toEqual([
      {
        scope: SHOP,
        input: {
          actor: { type: 'user', id: 'user-1' },
          action: 'update',
          entityType: 'core.membership',
          entityId: 'membership-1',
          details: { change: 'suspend', status: 'suspended' },
        },
      },
      {
        scope: SHOP,
        input: {
          actor: { type: 'system', id: null },
          action: 'create',
          entityType: 'core.role',
          entityId: 'role-1',
          details: { permissions: ['stock:view'] },
        },
      },
    ]);
  });
});

const subject = () => createInMemoryAccessStore();

describe('in-memory RoleRepository conformance', () => {
  for (const testCase of roleRepositoryConformance) {
    it(testCase.name, () => testCase.run(subject()));
  }
});

describe('in-memory MembershipRepository conformance', () => {
  for (const testCase of membershipRepositoryConformance) {
    it(testCase.name, () => testCase.run(subject()));
  }
});

describe('in-memory MembershipDirectory conformance', () => {
  for (const testCase of membershipDirectoryConformance) {
    it(testCase.name, () => testCase.run(subject()));
  }
});
