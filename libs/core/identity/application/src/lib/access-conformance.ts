import {
  IDENTITY_ERRORS,
  type Membership,
  type Role,
} from '@hk/core/identity/domain';
import {
  expectEqual,
  expectTrue,
  type ConformanceCase,
} from '@hk/platform/test-kit';
import { isDomainError } from '@hk/platform/universal';
import type {
  AccessUnitOfWork,
  BusinessScope,
  DirectoryEntry,
  MembershipDirectory,
  MembershipRepository,
  RoleRepository,
} from './ports';

/**
 * What every access repository must do, including keeping businesses apart.
 * Each adapter's test file runs these against itself. Every case starts
 * with empty storage.
 */
export interface AccessStorageSubject {
  roles: RoleRepository;
  memberships: MembershipRepository;
  directory: MembershipDirectory;
  unitOfWork: AccessUnitOfWork;
}

type AccessCase = ConformanceCase<AccessStorageSubject>;

const id = (n: number): string =>
  `018f0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const TENANT = id(0xf001);
const A: BusinessScope = { tenantId: TENANT, businessId: id(0xb001) };
const B: BusinessScope = { tenantId: TENANT, businessId: id(0xb002) };
/** Another tenant altogether. */
const C: BusinessScope = { tenantId: id(0xf002), businessId: id(0xb003) };
const USER_1 = id(0xa1);
const USER_2 = id(0xa2);
const T0 = '2026-11-28T09:00:00.123Z';
const later = (minutes: number): string =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const roleOf = (n: number, overrides: Partial<Role> = {}): Role => ({
  id: id(0x6000 + n),
  key: null,
  name: `Role ${n}`,
  permissions: ['accounts:view', 'invoices:view'],
  version: 1,
  ...overrides,
});

const memberOf = (
  n: number,
  overrides: Partial<Membership> = {},
): Membership => ({
  id: id(0x7000 + n),
  userId: id(0xa0 + n),
  roleId: roleOf(1).id,
  branchIds: null,
  status: 'active',
  joinedAt: later(n),
  version: 1,
  ...overrides,
});

const rejectionCode = async (
  action: () => Promise<unknown>,
): Promise<string | undefined> => {
  try {
    await action();
  } catch (error) {
    return isDomainError(error) ? error.code : `threw: ${String(error)}`;
  }
  return undefined;
};

const refused = async (action: () => Promise<unknown>): Promise<boolean> => {
  try {
    await action();
  } catch {
    return true;
  }
  return false;
};

export const roleRepositoryConformance: readonly AccessCase[] = [
  {
    name: 'a stored role is found by id and by its built-in key, exactly',
    run: async ({ roles, unitOfWork }) => {
      const custom = roleOf(1);
      const manager = roleOf(2, {
        key: 'manager',
        name: 'Manager',
        permissions: [],
      });
      await unitOfWork.tenant(A, async () => {
        await roles.create(custom);
        await roles.create(manager);
      });
      await unitOfWork.tenant(A, async () => {
        expectEqual(await roles.findById(custom.id), custom, 'the custom role');
        expectEqual(await roles.findByKey('manager'), manager, 'by key');
        expectEqual(await roles.findByKey('cashier'), null, 'a key not there');
        expectEqual(await roles.findById(id(404)), null, 'an unknown id');
      });
    },
  },
  {
    name: 'roles are listed built-in first, in their fixed order, then custom by name',
    run: async ({ roles, unitOfWork }) => {
      await unitOfWork.tenant(A, async () => {
        await roles.create(roleOf(1, { name: 'zebra keeper' }));
        await roles.create(roleOf(2, { key: 'cashier', name: 'Cashier' }));
        await roles.create(roleOf(3, { name: 'Auditor' }));
        await roles.create(roleOf(4, { key: 'owner', name: 'Owner' }));
      });
      const listed = await unitOfWork.tenant(A, () => roles.list());
      expectEqual(
        listed.map((role) => role.name),
        ['Owner', 'Cashier', 'Auditor', 'zebra keeper'],
        'the order',
      );
    },
  },
  {
    name: 'updating a role moves it to the next version, and a stale copy is refused',
    run: async ({ roles, unitOfWork }) => {
      const role = roleOf(1);
      await unitOfWork.tenant(A, () => roles.create(role));
      const updated = await unitOfWork.tenant(A, () =>
        roles.update({ ...role, name: 'Renamed', permissions: ['stock:view'] }),
      );
      expectEqual(
        updated,
        { ...role, name: 'Renamed', permissions: ['stock:view'], version: 2 },
        'the updated role',
      );
      expectEqual(
        await unitOfWork.tenant(A, () => roles.findById(role.id)),
        updated,
        'as stored',
      );
      // Someone still holding version 1 tries to save.
      expectEqual(
        await rejectionCode(() =>
          unitOfWork.tenant(A, () => roles.update({ ...role, name: 'Late' })),
        ),
        IDENTITY_ERRORS.CHANGED_MEANWHILE,
        'the stale save',
      );
      expectEqual(
        await rejectionCode(() =>
          unitOfWork.tenant(A, () => roles.update(roleOf(9))),
        ),
        IDENTITY_ERRORS.CHANGED_MEANWHILE,
        'a role that is not there',
      );
      const after = await unitOfWork.tenant(A, () => roles.findById(role.id));
      expectEqual(after?.name, 'Renamed', 'the stored name');
    },
  },
  {
    name: 'a role is removed once',
    run: async ({ roles, unitOfWork }) => {
      await unitOfWork.tenant(A, () => roles.create(roleOf(1)));
      expectEqual(
        await unitOfWork.tenant(A, () => roles.remove(roleOf(1).id)),
        true,
        'the first time',
      );
      expectEqual(
        await unitOfWork.tenant(A, () => roles.remove(roleOf(1).id)),
        false,
        'the second time',
      );
      expectEqual(
        await unitOfWork.tenant(A, () => roles.list()),
        [],
        'nothing is left',
      );
    },
  },
  {
    name: 'one business cannot see, change or remove another’s roles',
    run: async ({ roles, unitOfWork }) => {
      const role = roleOf(1, { key: 'manager', name: 'Manager' });
      await unitOfWork.tenant(A, () => roles.create(role));
      for (const other of [B, C]) {
        await unitOfWork.tenant(other, async () => {
          expectEqual(await roles.list(), [], 'the list');
          expectEqual(await roles.findById(role.id), null, 'by id');
          expectEqual(await roles.findByKey('manager'), null, 'by key');
          expectEqual(await roles.remove(role.id), false, 'removing it');
        });
        expectEqual(
          await rejectionCode(() =>
            unitOfWork.tenant(other, () =>
              roles.update({ ...role, name: 'Taken over' }),
            ),
          ),
          IDENTITY_ERRORS.CHANGED_MEANWHILE,
          'changing it',
        );
      }
      expectEqual(
        await unitOfWork.tenant(A, () => roles.findById(role.id)),
        role,
        'the role is untouched',
      );
      // Each business has its own copy of a built-in role.
      await unitOfWork.tenant(B, () =>
        roles.create(roleOf(2, { key: 'manager', name: 'Manager' })),
      );
      const own = await unitOfWork.tenant(B, () => roles.findByKey('manager'));
      expectEqual(own?.id, roleOf(2).id, 'the other business’s own copy');
    },
  },
  {
    name: 'roles cannot be reached outside a business',
    run: async ({ roles, unitOfWork }) => {
      await unitOfWork.tenant(A, () => roles.create(roleOf(1)));
      expectTrue(
        await refused(() => roles.list()),
        'with no unit of work at all',
      );
      expectTrue(
        await refused(() => unitOfWork.system(() => roles.list())),
        'in the unit of work that belongs to no business',
      );
    },
  },
  {
    name: 'a failed unit of work leaves nothing behind',
    run: async ({ roles, unitOfWork }) => {
      await refused(() =>
        unitOfWork.tenant(A, async () => {
          await roles.create(roleOf(1));
          throw new Error('failed after the change');
        }),
      );
      expectEqual(
        await unitOfWork.tenant(A, () => roles.list()),
        [],
        'the role was not kept',
      );
    },
  },
];

export const membershipRepositoryConformance: readonly AccessCase[] = [
  {
    name: 'a stored membership is found by id and by user, exactly',
    run: async ({ memberships, unitOfWork }) => {
      const everywhere = memberOf(1);
      const limited = memberOf(2, {
        branchIds: [id(0xbb01), id(0xbb02)],
        status: 'suspended',
      });
      await unitOfWork.tenant(A, async () => {
        await memberships.create(everywhere);
        await memberships.create(limited);
      });
      await unitOfWork.tenant(A, async () => {
        expectEqual(
          await memberships.findById(everywhere.id),
          everywhere,
          'every branch',
        );
        expectEqual(
          await memberships.findByUser(limited.userId),
          limited,
          'some branches',
        );
        expectEqual(await memberships.findById(id(404)), null, 'unknown id');
        expectEqual(
          await memberships.findByUser(id(404)),
          null,
          'unknown user',
        );
      });
    },
  },
  {
    name: 'a person has one membership in a business, whatever its status',
    run: async ({ memberships, unitOfWork }) => {
      await unitOfWork.tenant(A, () =>
        memberships.create(memberOf(1, { status: 'removed' })),
      );
      expectEqual(
        await rejectionCode(() =>
          unitOfWork.tenant(A, () =>
            memberships.create(memberOf(2, { userId: memberOf(1).userId })),
          ),
        ),
        IDENTITY_ERRORS.MEMBER_EXISTS,
        'a second membership for the same person',
      );
      // The same person in another business is a different membership.
      await unitOfWork.tenant(B, () =>
        memberships.create(memberOf(3, { userId: memberOf(1).userId })),
      );
      const other = await unitOfWork.tenant(B, () =>
        memberships.findByUser(memberOf(1).userId),
      );
      expectEqual(other?.id, memberOf(3).id, 'in the other business');
    },
  },
  {
    name: 'memberships are listed oldest first, removed ones included',
    run: async ({ memberships, unitOfWork }) => {
      await unitOfWork.tenant(A, async () => {
        // The ids and the join times are in different orders on purpose.
        await memberships.create(memberOf(3, { joinedAt: later(20) }));
        await memberships.create(
          memberOf(1, { status: 'removed', joinedAt: later(30) }),
        );
        await memberships.create(memberOf(2, { joinedAt: later(10) }));
      });
      const listed = await unitOfWork.tenant(A, () => memberships.list());
      expectEqual(
        listed.map((item) => item.id),
        [memberOf(2).id, memberOf(3).id, memberOf(1).id],
        'by when they joined',
      );
    },
  },
  {
    name: 'members holding a role are counted, not the removed ones',
    run: async ({ memberships, unitOfWork }) => {
      const other = roleOf(2).id;
      await unitOfWork.tenant(A, async () => {
        await memberships.create(memberOf(1));
        await memberships.create(memberOf(2, { status: 'suspended' }));
        await memberships.create(memberOf(3, { status: 'removed' }));
        await memberships.create(memberOf(4, { roleId: other }));
      });
      await unitOfWork.tenant(A, async () => {
        expectEqual(
          await memberships.countWithRole(roleOf(1).id),
          2,
          'active and suspended',
        );
        expectEqual(await memberships.countWithRole(other), 1, 'another role');
        expectEqual(await memberships.countWithRole(id(404)), 0, 'no holders');
      });
      expectEqual(
        await unitOfWork.tenant(B, () =>
          memberships.countWithRole(roleOf(1).id),
        ),
        0,
        'counted from another business',
      );
    },
  },
  {
    name: 'updating a membership moves it to the next version, and a stale copy is refused',
    run: async ({ memberships, unitOfWork }) => {
      const member = memberOf(1);
      await unitOfWork.tenant(A, () => memberships.create(member));
      const changed = {
        ...member,
        roleId: roleOf(2).id,
        branchIds: [id(0xbb01)],
        status: 'suspended' as const,
        joinedAt: later(30),
      };
      const updated = await unitOfWork.tenant(A, () =>
        memberships.update(changed),
      );
      expectEqual(
        updated,
        { ...changed, version: 2 },
        'the updated membership',
      );
      expectEqual(
        await unitOfWork.tenant(A, () => memberships.findById(member.id)),
        updated,
        'as stored',
      );
      const back = await unitOfWork.tenant(A, () =>
        memberships.update({ ...updated, branchIds: null }),
      );
      expectEqual(back.branchIds, null, 'back to every branch');
      expectEqual(
        await rejectionCode(() =>
          unitOfWork.tenant(A, () =>
            memberships.update({ ...member, status: 'removed' }),
          ),
        ),
        IDENTITY_ERRORS.CHANGED_MEANWHILE,
        'the stale save',
      );
    },
  },
  {
    name: 'one business cannot see or change another’s memberships',
    run: async ({ memberships, unitOfWork }) => {
      const member = memberOf(1);
      await unitOfWork.tenant(A, () => memberships.create(member));
      for (const other of [B, C]) {
        await unitOfWork.tenant(other, async () => {
          expectEqual(await memberships.list(), [], 'the list');
          expectEqual(await memberships.findById(member.id), null, 'by id');
          expectEqual(
            await memberships.findByUser(member.userId),
            null,
            'by user',
          );
        });
        expectEqual(
          await rejectionCode(() =>
            unitOfWork.tenant(other, () =>
              memberships.update({ ...member, status: 'removed' }),
            ),
          ),
          IDENTITY_ERRORS.CHANGED_MEANWHILE,
          'changing it',
        );
      }
      expectEqual(
        await unitOfWork.tenant(A, () => memberships.findById(member.id)),
        member,
        'the membership is untouched',
      );
    },
  },
  {
    name: 'memberships cannot be reached outside a business',
    run: async ({ memberships, unitOfWork }) => {
      await unitOfWork.tenant(A, () => memberships.create(memberOf(1)));
      expectTrue(
        await refused(() => memberships.list()),
        'with no unit of work at all',
      );
      expectTrue(
        await refused(() => unitOfWork.system(() => memberships.list())),
        'in the unit of work that belongs to no business',
      );
    },
  },
];

const entry = (
  userId: string,
  scope: BusinessScope,
  active = true,
): DirectoryEntry => ({ userId, ...scope, active });

export const membershipDirectoryConformance: readonly AccessCase[] = [
  {
    name: 'a line written inside a business is read outside any business',
    run: async ({ directory, unitOfWork }) => {
      await unitOfWork.tenant(A, () => directory.set(entry(USER_1, A)));
      await unitOfWork.system(async () => {
        expectEqual(
          await directory.find(USER_1, A.businessId),
          entry(USER_1, A),
          'the line',
        );
        expectEqual(
          await directory.find(USER_1, B.businessId),
          null,
          'another business',
        );
        expectEqual(
          await directory.find(USER_2, A.businessId),
          null,
          'another person',
        );
      });
    },
  },
  {
    name: 'setting a line again replaces it',
    run: async ({ directory, unitOfWork }) => {
      await unitOfWork.tenant(A, () => directory.set(entry(USER_1, A)));
      await unitOfWork.tenant(A, () => directory.set(entry(USER_1, A, false)));
      await unitOfWork.system(async () => {
        const found = await directory.find(USER_1, A.businessId);
        expectEqual(found?.active, false, 'the line now');
        expectEqual(await directory.listActive(USER_1), [], 'nothing active');
      });
    },
  },
  {
    name: 'a person’s active businesses are listed, across tenants, and nobody else’s',
    run: async ({ directory, unitOfWork }) => {
      await unitOfWork.tenant(A, () => directory.set(entry(USER_1, A)));
      await unitOfWork.tenant(B, () => directory.set(entry(USER_1, B, false)));
      await unitOfWork.tenant(C, () => directory.set(entry(USER_1, C)));
      await unitOfWork.tenant(B, () => directory.set(entry(USER_2, B)));
      await unitOfWork.system(async () => {
        const mine = await directory.listActive(USER_1);
        expectEqual(
          mine.map((item) => item.businessId).sort(),
          [A.businessId, C.businessId].sort(),
          'the active ones',
        );
        expectEqual(
          mine.find((item) => item.businessId === C.businessId)?.tenantId,
          C.tenantId,
          'each with its tenant',
        );
        expectEqual(await directory.listActive(id(404)), [], 'a stranger');
      });
    },
  },
  {
    name: 'a line can only be written for the business that is open',
    run: async ({ directory, unitOfWork }) => {
      expectTrue(
        await refused(() =>
          unitOfWork.tenant(A, () => directory.set(entry(USER_1, B))),
        ),
        'a line for another business',
      );
      expectTrue(
        await refused(() =>
          unitOfWork.tenant(A, () =>
            directory.set({ ...entry(USER_1, A), tenantId: C.tenantId }),
          ),
        ),
        'a line naming another tenant',
      );
      expectTrue(
        await refused(() =>
          unitOfWork.system(() => directory.set(entry(USER_1, A))),
        ),
        'a line written outside any business',
      );
      expectEqual(
        await unitOfWork.system(() => directory.listActive(USER_1)),
        [],
        'nothing was written',
      );
    },
  },
  {
    name: 'a line is written with the unit of work, or not at all',
    run: async ({ directory, unitOfWork }) => {
      await refused(() =>
        unitOfWork.tenant(A, async () => {
          await directory.set(entry(USER_1, A));
          throw new Error('failed after the change');
        }),
      );
      expectEqual(
        await unitOfWork.system(() => directory.find(USER_1, A.businessId)),
        null,
        'the line was not kept',
      );
    },
  },
  {
    name: 'one kind of unit of work cannot be opened inside the other',
    run: async ({ unitOfWork }) => {
      expectTrue(
        await refused(() =>
          unitOfWork.tenant(A, () => unitOfWork.system(async () => 1)),
        ),
        'system inside a business',
      );
      expectTrue(
        await refused(() =>
          unitOfWork.system(() => unitOfWork.tenant(A, async () => 1)),
        ),
        'a business inside system',
      );
      expectTrue(
        await refused(() =>
          unitOfWork.tenant(A, () => unitOfWork.tenant(B, async () => 1)),
        ),
        'one business inside another',
      );
      // The same business joins.
      expectEqual(
        await unitOfWork.tenant(A, () => unitOfWork.tenant(A, async () => 7)),
        7,
        'the same business inside itself',
      );
    },
  },
];
