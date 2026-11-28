import {
  OWNER_ROLE_KEY,
  SYSTEM_ROLE_KEYS,
  SYSTEM_ROLE_NAMES,
  defaultPermissionsOf,
  type Permission,
  type SystemRoleKey,
} from '@hk/contracts/permissions';
import {
  ACCESS_RULES,
  IDENTITY_ERRORS,
  canEnterBranch,
  canSignIn,
  grantedBy,
  isOwnerRole,
  judgeMemberChange,
  parseBranchScope,
  parseRoleName,
  parseRolePermissions,
  permissionsBeyond,
  permissionsHeld,
  roleNameKey,
  type Access,
  type MemberChange,
  type MemberStatus,
  type Membership,
  type Role,
} from '@hk/core/identity/domain';
import type { Clock, DomainError } from '@hk/platform/universal';
import { identityFailure } from './otp-flow';
import type {
  AccessAudit,
  AccessAuditEvent,
  AccessUnitOfWork,
  BusinessScope,
  MembershipDirectory,
  MembershipRepository,
  ProductEntitlements,
  RoleRepository,
  UserRepository,
} from './ports';

/**
 * Access: the roles and members of a business, and working out what a
 * person may do in it.
 *
 * None of these runs offline. A device that is offline works with the
 * permissions it was given when it last synced.
 */
export const ACCESS_USE_CASES = {
  provisionBusiness: {
    name: 'core.identity.provision_business_access',
    offline: false,
  },
  authorize: { name: 'core.identity.authorize', offline: false },
  listBusinesses: { name: 'core.identity.list_businesses', offline: false },
  listRoles: { name: 'core.identity.list_roles', offline: false },
  createRole: { name: 'core.identity.create_role', offline: false },
  updateRole: { name: 'core.identity.update_role', offline: false },
  deleteRole: { name: 'core.identity.delete_role', offline: false },
  listMembers: { name: 'core.identity.list_members', offline: false },
  addMember: { name: 'core.identity.add_member', offline: false },
  changeMemberRole: {
    name: 'core.identity.change_member_role',
    offline: false,
  },
  setMemberBranches: {
    name: 'core.identity.set_member_branches',
    offline: false,
  },
  suspendMember: { name: 'core.identity.suspend_member', offline: false },
  reinstateMember: { name: 'core.identity.reinstate_member', offline: false },
  removeMember: { name: 'core.identity.remove_member', offline: false },
} as const;

/** A member as shown in a business's list of people. */
export interface MemberSummary {
  id: string;
  userId: string;
  /** The person's name, or null when the account no longer exists. */
  name: string | null;
  role: { id: string; key: SystemRoleKey | null; name: string } | null;
  branchIds: readonly string[] | null;
  status: MemberStatus;
  joinedAt: string;
}

/** Who is acting, and in which business. Every managing use case takes this. */
export interface Acting {
  scope: BusinessScope;
  actorUserId: string;
}

export interface AccessOptions {
  users: UserRepository;
  roles: RoleRepository;
  memberships: MembershipRepository;
  directory: MembershipDirectory;
  unitOfWork: AccessUnitOfWork;
  entitlements: ProductEntitlements;
  /** Optional: where changes are recorded. */
  audit?: AccessAudit;
  clock: Clock;
  /** Makes ids. A UUID v7 generator in production. */
  newId: () => string;
}

export interface AccessService {
  /**
   * Gives a new business its built-in roles and its owner. Called by
   * tenancy when a business is created, inside that unit of work. Safe to
   * call again: it adds only what is missing.
   */
  provisionBusiness(input: {
    scope: BusinessScope;
    ownerUserId: string;
  }): Promise<void>;
  /**
   * Works out what a person may do in a business, for one request. The
   * gateway calls this with the business and branch the request names.
   * Refuses with IDENTITY_ACCESS_DENIED for anyone who is not an active
   * member, without saying why.
   */
  authorize(input: {
    userId: string;
    businessId: string;
    branchId?: string | null;
  }): Promise<Access>;
  /** The businesses a person may enter now. */
  listBusinesses(input: { userId: string }): Promise<BusinessScope[]>;

  listRoles(acting: Acting): Promise<Role[]>;
  createRole(
    input: Acting & { name: string; permissions: readonly string[] },
  ): Promise<Role>;
  /** Changes a role's name or permissions. The owner role cannot be changed. */
  updateRole(
    input: Acting & {
      roleId: string;
      name?: string;
      permissions?: readonly string[];
    },
  ): Promise<Role>;
  /** Deletes a custom role nobody holds. */
  deleteRole(input: Acting & { roleId: string }): Promise<void>;

  listMembers(acting: Acting): Promise<MemberSummary[]>;
  /**
   * Makes a person a member. The invite flow ends here; so does adding
   * someone directly. A person removed earlier becomes a member again.
   */
  addMember(
    input: Acting & {
      userId: string;
      roleId: string;
      branchIds?: readonly string[] | null;
    },
  ): Promise<Membership>;
  changeMemberRole(
    input: Acting & { membershipId: string; roleId: string },
  ): Promise<Membership>;
  setMemberBranches(
    input: Acting & {
      membershipId: string;
      branchIds: readonly string[] | null;
    },
  ): Promise<Membership>;
  suspendMember(input: Acting & { membershipId: string }): Promise<Membership>;
  reinstateMember(
    input: Acting & { membershipId: string },
  ): Promise<Membership>;
  removeMember(input: Acting & { membershipId: string }): Promise<Membership>;
}

const denied = (): DomainError =>
  identityFailure(
    IDENTITY_ERRORS.ACCESS_DENIED,
    'You do not have access to do this.',
    undefined,
    'forbidden',
  );

const notFound = (code: string, what: string): DomainError =>
  identityFailure(code, `The ${what} was not found.`, undefined, 'not-found');

const conflict = (
  code: string,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): DomainError => identityFailure(code, message, details, 'conflict');

const forbidden = (
  code: string,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): DomainError => identityFailure(code, message, details, 'forbidden');

export const createAccess = (options: AccessOptions): AccessService => {
  const {
    users,
    roles,
    memberships,
    directory,
    unitOfWork,
    entitlements,
    audit,
    clock,
    newId,
  } = options;

  const nowIso = (): string => clock.now().toISOString();

  const record = async (
    scope: BusinessScope,
    event: AccessAuditEvent,
  ): Promise<void> => {
    if (audit) await audit.record(scope, event);
  };

  /**
   * The acting member, checked: an active member of this business whose
   * role holds `needed`. Runs inside the business's unit of work.
   */
  const actorIn = async (
    acting: Acting,
    needed: Permission,
  ): Promise<{ membership: Membership; role: Role; granted: string[] }> => {
    const membership = await memberships.findByUser(acting.actorUserId);
    const role =
      membership && membership.status === 'active'
        ? await roles.findById(membership.roleId)
        : null;
    if (!membership || !role) throw denied();
    const held = permissionsHeld(
      role,
      await entitlements.enabledProducts(acting.scope),
    );
    if (!held.includes(needed)) throw denied();
    return { membership, role, granted: grantedBy(role) };
  };

  /** Refuses when `wanted` has a permission the actor does not hold. */
  const mustNotExceed = (
    granted: readonly string[],
    wanted: readonly string[],
  ): void => {
    const beyond = permissionsBeyond(granted, wanted);
    if (beyond.length > 0) {
      throw forbidden(
        IDENTITY_ERRORS.PERMISSION_EXCEEDS_OWN,
        'You cannot give, or act on, access greater than your own.',
        { permissions: beyond.length },
      );
    }
  };

  const setDirectory = (
    scope: BusinessScope,
    membership: Membership,
  ): Promise<void> =>
    directory.set({
      userId: membership.userId,
      tenantId: scope.tenantId,
      businessId: scope.businessId,
      active: membership.status === 'active',
    });

  const provisionBusiness: AccessService['provisionBusiness'] = async (
    input,
  ) => {
    const { scope, ownerUserId } = input;
    await unitOfWork.tenant(scope, async () => {
      let ownerRole: Role | null = null;
      for (const key of SYSTEM_ROLE_KEYS) {
        let role = await roles.findByKey(key);
        if (!role) {
          role = {
            id: newId(),
            key,
            name: SYSTEM_ROLE_NAMES[key],
            // The owner's permissions are never read from storage.
            permissions:
              key === OWNER_ROLE_KEY ? [] : defaultPermissionsOf(key),
            version: 1,
          };
          await roles.create(role);
        }
        if (key === OWNER_ROLE_KEY) ownerRole = role;
      }
      const owner = ownerRole as Role;
      const everyone = await memberships.list();
      const currentOwner = everyone.find(
        (membership) =>
          membership.roleId === owner.id && membership.status !== 'removed',
      );
      if (currentOwner) {
        // Provisioning never replaces an owner, or adds a second one.
        if (currentOwner.userId !== ownerUserId) {
          throw conflict(
            IDENTITY_ERRORS.OWNER_PROTECTED,
            'The business already has an owner.',
          );
        }
        return;
      }
      if (everyone.some((membership) => membership.userId === ownerUserId)) {
        throw conflict(
          IDENTITY_ERRORS.MEMBER_EXISTS,
          'This person is already a member of the business.',
        );
      }
      const membership: Membership = {
        id: newId(),
        userId: ownerUserId,
        roleId: owner.id,
        branchIds: null,
        status: 'active',
        joinedAt: nowIso(),
        version: 1,
      };
      await memberships.create(membership);
      await setDirectory(scope, membership);
      await record(scope, {
        actorUserId: ownerUserId,
        action: 'create',
        entityType: 'core.membership',
        entityId: membership.id,
        details: { userId: ownerUserId, role: OWNER_ROLE_KEY },
      });
    });
  };

  const authorize: AccessService['authorize'] = async (input) => {
    // First, outside any business: is there a live link at all, and may the
    // person still sign in? This also finds the tenant the business is in.
    const entry = await unitOfWork.system(async () => {
      const [found, user] = [
        await directory.find(input.userId, input.businessId),
        await users.findById(input.userId),
      ];
      return found && found.active && user && canSignIn(user) ? found : null;
    });
    if (!entry) throw denied();
    const scope: BusinessScope = {
      tenantId: entry.tenantId,
      businessId: entry.businessId,
    };
    // Then, inside the business: the membership itself is what decides. The
    // directory only said where to look.
    return unitOfWork.tenant(scope, async () => {
      const membership = await memberships.findByUser(input.userId);
      const role =
        membership && membership.status === 'active'
          ? await roles.findById(membership.roleId)
          : null;
      if (!membership || !role) throw denied();
      const branchId = input.branchId ?? null;
      if (branchId !== null && !canEnterBranch(membership, branchId)) {
        throw forbidden(
          IDENTITY_ERRORS.BRANCH_DENIED,
          'You do not have access to this branch.',
        );
      }
      return {
        userId: membership.userId,
        tenantId: scope.tenantId,
        businessId: scope.businessId,
        membershipId: membership.id,
        roleId: role.id,
        roleKey: role.key,
        isOwner: isOwnerRole(role),
        branchIds: membership.branchIds,
        branchId,
        permissions: permissionsHeld(
          role,
          await entitlements.enabledProducts(scope),
        ),
      };
    });
  };

  const listBusinesses: AccessService['listBusinesses'] = async (input) =>
    (await unitOfWork.system(() => directory.listActive(input.userId))).map(
      (entry) => ({ tenantId: entry.tenantId, businessId: entry.businessId }),
    );

  const listRoles: AccessService['listRoles'] = (acting) =>
    unitOfWork.tenant(acting.scope, async () => {
      await actorIn(acting, 'roles:view');
      return roles.list();
    });

  const nameTaken = (all: readonly Role[], name: string, exceptId?: string) =>
    all.some(
      (role) =>
        role.id !== exceptId && roleNameKey(role.name) === roleNameKey(name),
    );

  const createRole: AccessService['createRole'] = async (input) => {
    const name = parseRoleName(input.name);
    if (!name.ok) throw name.error;
    const permissions = parseRolePermissions(input.permissions);
    if (!permissions.ok) throw permissions.error;

    return unitOfWork.tenant(input.scope, async () => {
      const actor = await actorIn(input, 'roles:manage');
      mustNotExceed(actor.granted, permissions.value);
      const all = await roles.list();
      if (all.length >= ACCESS_RULES.maxRolesPerBusiness) {
        throw conflict(
          IDENTITY_ERRORS.ROLE_LIMIT,
          'The business has as many roles as are allowed.',
          { max: ACCESS_RULES.maxRolesPerBusiness },
        );
      }
      if (nameTaken(all, name.value)) {
        throw conflict(
          IDENTITY_ERRORS.ROLE_NAME_TAKEN,
          'The business already has a role with this name.',
        );
      }
      const role: Role = {
        id: newId(),
        key: null,
        name: name.value,
        permissions: permissions.value,
        version: 1,
      };
      await roles.create(role);
      await record(input.scope, {
        actorUserId: input.actorUserId,
        action: 'create',
        entityType: 'core.role',
        entityId: role.id,
        details: { permissions: [...role.permissions] },
      });
      return role;
    });
  };

  const updateRole: AccessService['updateRole'] = async (input) => {
    const name =
      input.name === undefined ? undefined : parseRoleName(input.name);
    if (name && !name.ok) throw name.error;
    const permissions =
      input.permissions === undefined
        ? undefined
        : parseRolePermissions(input.permissions);
    if (permissions && !permissions.ok) throw permissions.error;

    return unitOfWork.tenant(input.scope, async () => {
      const actor = await actorIn(input, 'roles:manage');
      const role = await roles.findById(input.roleId);
      if (!role) throw notFound(IDENTITY_ERRORS.ROLE_NOT_FOUND, 'role');
      if (isOwnerRole(role)) {
        throw forbidden(
          IDENTITY_ERRORS.ROLE_LOCKED,
          'The owner role cannot be changed.',
        );
      }
      // Both what the role grants now and what it would grant must be
      // within the actor's own access: otherwise someone could strip, or
      // rewrite, a role more powerful than their own.
      mustNotExceed(actor.granted, role.permissions);
      if (permissions) mustNotExceed(actor.granted, permissions.value);
      if (name && name.value !== role.name) {
        if (role.key !== null) {
          throw forbidden(
            IDENTITY_ERRORS.ROLE_LOCKED,
            'A built-in role keeps its name.',
          );
        }
        if (nameTaken(await roles.list(), name.value, role.id)) {
          throw conflict(
            IDENTITY_ERRORS.ROLE_NAME_TAKEN,
            'The business already has a role with this name.',
          );
        }
      }
      const updated = await roles.update({
        ...role,
        name: name ? name.value : role.name,
        permissions: permissions ? permissions.value : role.permissions,
      });
      await record(input.scope, {
        actorUserId: input.actorUserId,
        action: 'update',
        entityType: 'core.role',
        entityId: role.id,
        details: { permissions: [...updated.permissions] },
      });
      return updated;
    });
  };

  const deleteRole: AccessService['deleteRole'] = (input) =>
    unitOfWork.tenant(input.scope, async () => {
      const actor = await actorIn(input, 'roles:manage');
      const role = await roles.findById(input.roleId);
      if (!role) throw notFound(IDENTITY_ERRORS.ROLE_NOT_FOUND, 'role');
      if (role.key !== null) {
        throw forbidden(
          IDENTITY_ERRORS.ROLE_LOCKED,
          'A built-in role cannot be deleted.',
        );
      }
      mustNotExceed(actor.granted, role.permissions);
      const holders = await memberships.countWithRole(role.id);
      if (holders > 0) {
        throw conflict(
          IDENTITY_ERRORS.ROLE_IN_USE,
          'Members still hold this role. Give them another role first.',
          { members: holders },
        );
      }
      await roles.remove(role.id);
      await record(input.scope, {
        actorUserId: input.actorUserId,
        action: 'delete',
        entityType: 'core.role',
        entityId: role.id,
        details: {},
      });
    });

  const listMembers: AccessService['listMembers'] = async (acting) => {
    const found = await unitOfWork.tenant(acting.scope, async () => {
      await actorIn(acting, 'members:view');
      const all = await roles.list();
      return (await memberships.list())
        .filter((membership) => membership.status !== 'removed')
        .map((membership) => ({
          membership,
          role: all.find((role) => role.id === membership.roleId) ?? null,
        }));
    });
    // Names belong to people, not to the business, so they are read outside
    // it, in a second unit of work.
    const names = await unitOfWork.system(async () => {
      const byId = new Map<string, string | null>();
      for (const { membership } of found) {
        byId.set(
          membership.userId,
          (await users.findById(membership.userId))?.name ?? null,
        );
      }
      return byId;
    });
    return found.map(({ membership, role }) => ({
      id: membership.id,
      userId: membership.userId,
      name: names.get(membership.userId) ?? null,
      role: role ? { id: role.id, key: role.key, name: role.name } : null,
      branchIds: membership.branchIds,
      status: membership.status,
      joinedAt: membership.joinedAt,
    }));
  };

  /** A role that may be handed to a member by this actor. */
  const assignableRole = async (
    roleId: string,
    granted: readonly string[],
  ): Promise<Role> => {
    const role = await roles.findById(roleId);
    if (!role) throw notFound(IDENTITY_ERRORS.ROLE_NOT_FOUND, 'role');
    if (isOwnerRole(role)) {
      throw forbidden(
        IDENTITY_ERRORS.OWNER_PROTECTED,
        'Nobody can be made owner by giving them the owner role.',
      );
    }
    mustNotExceed(granted, role.permissions);
    return role;
  };

  const addMember: AccessService['addMember'] = async (input) => {
    const branches = parseBranchScope(input.branchIds);
    if (!branches.ok) throw branches.error;
    const person = await unitOfWork.system(() => users.findById(input.userId));
    if (!person || !canSignIn(person)) {
      throw notFound(IDENTITY_ERRORS.USER_NOT_FOUND, 'account');
    }

    return unitOfWork.tenant(input.scope, async () => {
      const actor = await actorIn(input, 'members:invite');
      const role = await assignableRole(input.roleId, actor.granted);
      const existing = await memberships.findByUser(input.userId);
      if (existing && existing.status !== 'removed') {
        throw conflict(
          IDENTITY_ERRORS.MEMBER_EXISTS,
          'This person is already a member of the business.',
        );
      }
      const membership = existing
        ? await memberships.update({
            ...existing,
            roleId: role.id,
            branchIds: branches.value,
            status: 'active',
            joinedAt: nowIso(),
          })
        : {
            id: newId(),
            userId: input.userId,
            roleId: role.id,
            branchIds: branches.value,
            status: 'active' as const,
            joinedAt: nowIso(),
            version: 1,
          };
      if (!existing) await memberships.create(membership);
      await setDirectory(input.scope, membership);
      await record(input.scope, {
        actorUserId: input.actorUserId,
        action: 'create',
        entityType: 'core.membership',
        entityId: membership.id,
        details: { userId: membership.userId, roleId: role.id },
      });
      return membership;
    });
  };

  /**
   * Changes one membership. The checks every such change shares are here:
   * the actor's permission, the protections of the owner and of oneself,
   * and that the member being changed does not out-rank the actor.
   */
  const changeMember = (
    input: Acting & { membershipId: string },
    change: MemberChange,
    needed: Permission,
    apply: (
      target: Membership,
      actorGranted: readonly string[],
    ) => Promise<Membership>,
  ): Promise<Membership> =>
    unitOfWork.tenant(input.scope, async () => {
      const actor = await actorIn(input, needed);
      const target = await memberships.findById(input.membershipId);
      if (!target) throw notFound(IDENTITY_ERRORS.MEMBER_NOT_FOUND, 'member');
      const targetRole = await roles.findById(target.roleId);
      const verdict = judgeMemberChange({
        actorUserId: input.actorUserId,
        target,
        // A member whose role has gone is treated as holding nothing.
        targetRole: targetRole ?? { key: null },
        change,
      });
      if (!verdict.allowed) {
        switch (verdict.reason) {
          case 'owner_protected':
            throw forbidden(
              IDENTITY_ERRORS.OWNER_PROTECTED,
              'The owner’s membership cannot be changed.',
            );
          case 'self':
            throw forbidden(
              IDENTITY_ERRORS.SELF_CHANGE_FORBIDDEN,
              'You cannot change your own membership.',
            );
          case 'not_a_member':
            throw notFound(IDENTITY_ERRORS.MEMBER_NOT_FOUND, 'member');
          default:
            return target;
        }
      }
      if (targetRole) mustNotExceed(actor.granted, grantedBy(targetRole));
      const updated = await apply(target, actor.granted);
      await setDirectory(input.scope, updated);
      await record(input.scope, {
        actorUserId: input.actorUserId,
        action: change === 'remove' ? 'delete' : 'update',
        entityType: 'core.membership',
        entityId: updated.id,
        details: {
          change,
          userId: updated.userId,
          roleId: updated.roleId,
          status: updated.status,
        },
      });
      return updated;
    });

  const changeMemberRole: AccessService['changeMemberRole'] = (input) =>
    changeMember(input, 'role', 'members:update', async (target, granted) => {
      const role = await assignableRole(input.roleId, granted);
      return memberships.update({ ...target, roleId: role.id });
    });

  const setMemberBranches: AccessService['setMemberBranches'] = async (
    input,
  ) => {
    const branches = parseBranchScope(input.branchIds);
    if (!branches.ok) throw branches.error;
    return changeMember(input, 'branches', 'members:update', (target) =>
      memberships.update({ ...target, branchIds: branches.value }),
    );
  };

  const suspendMember: AccessService['suspendMember'] = (input) =>
    changeMember(input, 'suspend', 'members:update', (target) =>
      memberships.update({ ...target, status: 'suspended' }),
    );

  const reinstateMember: AccessService['reinstateMember'] = (input) =>
    changeMember(input, 'reinstate', 'members:update', (target) =>
      memberships.update({ ...target, status: 'active' }),
    );

  const removeMember: AccessService['removeMember'] = (input) =>
    changeMember(input, 'remove', 'members:remove', (target) =>
      memberships.update({ ...target, status: 'removed' }),
    );

  return {
    provisionBusiness,
    authorize,
    listBusinesses,
    listRoles,
    createRole,
    updateRole,
    deleteRole,
    listMembers,
    addMember,
    changeMemberRole,
    setMemberBranches,
    suspendMember,
    reinstateMember,
    removeMember,
  };
};
