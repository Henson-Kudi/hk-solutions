import {
  SYSTEM_ROLE_KEYS,
  type SystemRoleKey,
} from '@hk/contracts/permissions';
import type { ProductKey } from '@hk/contracts/product-manifest';
import {
  IDENTITY_ERRORS,
  type Membership,
  type Role,
} from '@hk/core/identity/domain';
import { DomainError } from '@hk/platform/universal';
import type {
  AccessAudit,
  AccessAuditEvent,
  AccessUnitOfWork,
  BusinessScope,
  DirectoryEntry,
  MembershipDirectory,
  MembershipRepository,
  ProductEntitlements,
  RoleRepository,
} from './ports';

/**
 * In-memory access storage, for tests and local tools.
 *
 * It keeps the same wall the database does. Roles and memberships can be
 * reached only inside `unitOfWork.tenant`, and only those of that business;
 * the directory can be read only inside `unitOfWork.system`. Code that
 * reaches across, which row-level security would stop on the server, fails
 * here too.
 */

const keyOf = (scope: BusinessScope): string =>
  `${scope.tenantId}/${scope.businessId}`;

const stale = (): DomainError =>
  new DomainError(
    IDENTITY_ERRORS.CHANGED_MEANWHILE,
    'It was changed by someone else. Read it again and retry.',
    { kind: 'conflict' },
  );

const outside = (what: string): DomainError =>
  new DomainError(
    'TRANSACTION_MISSING',
    `${what} was used in the wrong place.`,
    {
      kind: 'invariant',
    },
  );

interface State {
  roles: Record<string, Role[]>;
  memberships: Record<string, Membership[]>;
  directory: DirectoryEntry[];
}

export interface InMemoryAccessStore {
  roles: RoleRepository;
  memberships: MembershipRepository;
  directory: MembershipDirectory;
  unitOfWork: AccessUnitOfWork;
}

export const createInMemoryAccessStore = (): InMemoryAccessStore => {
  let state: State = { roles: {}, memberships: {}, directory: [] };
  /** Where the running code is: a business, outside any, or nowhere. */
  let place:
    | { kind: 'tenant'; scope: BusinessScope }
    | { kind: 'system' }
    | null = null;

  const scopeKey = (what: string): string => {
    if (place?.kind !== 'tenant') throw outside(what);
    return keyOf(place.scope);
  };
  const inSystem = (what: string): void => {
    if (place?.kind !== 'system') throw outside(what);
  };
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const rolesOf = (what: string): Role[] =>
    (state.roles[scopeKey(what)] ??= []);
  const membersOf = (what: string): Membership[] =>
    (state.memberships[scopeKey(what)] ??= []);

  const systemOrder = (role: Role): number =>
    role.key === null
      ? SYSTEM_ROLE_KEYS.length
      : SYSTEM_ROLE_KEYS.indexOf(role.key);

  const roles: RoleRepository = {
    list: async () =>
      copy(
        [...rolesOf('roles.list')].sort(
          (a, b) =>
            systemOrder(a) - systemOrder(b) ||
            (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1),
        ),
      ),
    findById: async (roleId) =>
      copy(
        rolesOf('roles.findById').find((role) => role.id === roleId) ?? null,
      ),
    findByKey: async (key: SystemRoleKey) =>
      copy(rolesOf('roles.findByKey').find((role) => role.key === key) ?? null),
    create: async (role) => {
      rolesOf('roles.create').push(copy(role));
    },
    update: async (role) => {
      const all = rolesOf('roles.update');
      const index = all.findIndex((item) => item.id === role.id);
      if (index < 0 || all[index]?.version !== role.version) throw stale();
      const next = { ...copy(role), version: role.version + 1 };
      all[index] = next;
      return copy(next);
    },
    remove: async (roleId) => {
      const all = rolesOf('roles.remove');
      const index = all.findIndex((item) => item.id === roleId);
      if (index < 0) return false;
      all.splice(index, 1);
      return true;
    },
  };

  const memberships: MembershipRepository = {
    findById: async (membershipId) =>
      copy(
        membersOf('memberships.findById').find(
          (item) => item.id === membershipId,
        ) ?? null,
      ),
    findByUser: async (userId) =>
      copy(
        membersOf('memberships.findByUser').find(
          (item) => item.userId === userId,
        ) ?? null,
      ),
    list: async () =>
      copy(
        [...membersOf('memberships.list')].sort((a, b) =>
          a.joinedAt === b.joinedAt
            ? a.id < b.id
              ? -1
              : 1
            : a.joinedAt < b.joinedAt
              ? -1
              : 1,
        ),
      ),
    countWithRole: async (roleId) =>
      membersOf('memberships.countWithRole').filter(
        (item) => item.roleId === roleId && item.status !== 'removed',
      ).length,
    create: async (membership) => {
      const all = membersOf('memberships.create');
      if (all.some((item) => item.userId === membership.userId)) {
        throw new DomainError(
          IDENTITY_ERRORS.MEMBER_EXISTS,
          'This person is already a member of the business.',
          { kind: 'conflict' },
        );
      }
      all.push(copy(membership));
    },
    update: async (membership) => {
      const all = membersOf('memberships.update');
      const index = all.findIndex((item) => item.id === membership.id);
      if (index < 0 || all[index]?.version !== membership.version) {
        throw stale();
      }
      const next = { ...copy(membership), version: membership.version + 1 };
      all[index] = next;
      return copy(next);
    },
  };

  const directory: MembershipDirectory = {
    set: async (entry) => {
      // Written with the membership it mirrors, so inside the business.
      const key = scopeKey('directory.set');
      if (keyOf(entry) !== key) throw outside('directory.set');
      state.directory = [
        ...state.directory.filter(
          (item) =>
            !(
              item.userId === entry.userId &&
              item.businessId === entry.businessId
            ),
        ),
        copy(entry),
      ];
    },
    find: async (userId, businessId) => {
      inSystem('directory.find');
      return copy(
        state.directory.find(
          (item) => item.userId === userId && item.businessId === businessId,
        ) ?? null,
      );
    },
    listActive: async (userId) => {
      inSystem('directory.listActive');
      return copy(
        state.directory
          .filter((item) => item.userId === userId && item.active)
          .sort((a, b) => (a.businessId < b.businessId ? -1 : 1)),
      );
    },
  };

  const run = async <T>(
    next: NonNullable<typeof place>,
    action: () => Promise<T>,
  ): Promise<T> => {
    if (place) {
      const same =
        place.kind === next.kind &&
        (place.kind === 'system' ||
          (next.kind === 'tenant' && keyOf(place.scope) === keyOf(next.scope)));
      if (!same) {
        throw new DomainError(
          'TRANSACTION_KIND_MISMATCH',
          'A unit of work for another place is already open.',
          { kind: 'invariant' },
        );
      }
      // Joins the unit of work already open.
      return action();
    }
    const before = copy(state);
    place = next;
    try {
      return await action();
    } catch (error) {
      // Like a transaction: nothing the failed action did remains.
      state = before;
      throw error;
    } finally {
      place = null;
    }
  };

  return {
    roles,
    memberships,
    directory,
    unitOfWork: {
      tenant: (scope, action) => run({ kind: 'tenant', scope }, action),
      system: (action) => run({ kind: 'system' }, action),
    },
  };
};

/** Product entitlements fixed in advance, FOR TESTS: the same products for every business unless set. */
export const createFixedEntitlements = (
  products: readonly ProductKey[],
): ProductEntitlements & {
  set(scope: BusinessScope, products: readonly ProductKey[]): void;
} => {
  const perBusiness = new Map<string, readonly ProductKey[]>();
  return {
    set: (scope, enabled) => {
      perBusiness.set(keyOf(scope), enabled);
    },
    enabledProducts: async (scope) => [
      ...(perBusiness.get(keyOf(scope)) ?? products),
    ],
  };
};

/** An audit sink that remembers what it was given, FOR TESTS. */
export const createRecordingAccessAudit = (): AccessAudit & {
  events: (AccessAuditEvent & { scope: BusinessScope })[];
} => {
  const events: (AccessAuditEvent & { scope: BusinessScope })[] = [];
  return {
    events,
    record: async (scope, event) => {
      events.push({ ...event, scope });
    },
  };
};
