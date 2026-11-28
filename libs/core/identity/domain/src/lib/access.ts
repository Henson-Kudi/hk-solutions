import {
  ALL_PERMISSIONS,
  OWNER_ROLE_KEY,
  effectivePermissions,
  isPermission,
  type Permission,
  type SystemRoleKey,
} from '@hk/contracts/permissions';
import type { ProductKey } from '@hk/contracts/product-manifest';
import { DomainError, err, ok, type Result } from '@hk/platform/universal';
import { IDENTITY_ERRORS } from './errors';

/**
 * Access: who may enter a business, and what they may do there.
 *
 * A person enters a business through a membership. A membership has one
 * role, and may be limited to some of the business's branches. A role is a
 * set of permissions. Every business starts with the built-in roles and may
 * add its own.
 */
export const ACCESS_RULES = {
  roleNameMinLength: 2,
  roleNameMaxLength: 40,
  /** Built-in and custom roles together. */
  maxRolesPerBusiness: 50,
  /** The most branches one membership can be limited to. */
  maxBranchesPerMember: 200,
} as const;

/** A role of one business. */
export interface Role {
  id: string;
  /** The built-in role this is the business's copy of, or null for a custom role. */
  key: SystemRoleKey | null;
  name: string;
  /**
   * The permissions the role grants, as stored. For the owner role this is
   * ignored: see grantedBy.
   */
  permissions: readonly string[];
  version: number;
}

export const MEMBER_STATUSES = ['active', 'suspended', 'removed'] as const;

export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** One person's place in one business. */
export interface Membership {
  id: string;
  userId: string;
  roleId: string;
  /** The branches the person may work in, or null for every branch. */
  branchIds: readonly string[] | null;
  status: MemberStatus;
  /** ISO 8601 instant the person joined. */
  joinedAt: string;
  version: number;
}

export const isOwnerRole = (role: Pick<Role, 'key'>): boolean =>
  role.key === OWNER_ROLE_KEY;

/**
 * What a role grants. The owner holds every permission in the registry,
 * including ones added after the business was created; nothing stored can
 * take that away.
 */
export const grantedBy = (role: Pick<Role, 'key' | 'permissions'>): string[] =>
  isOwnerRole(role) ? [...ALL_PERMISSIONS] : [...role.permissions];

const fail = (
  code: string,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): DomainError => new DomainError(code, message, { details });

/** Cleans a role's name: single spaces, no control characters, a bounded length. */
export const parseRoleName = (input: unknown): Result<string> => {
  const cleaned =
    typeof input === 'string'
      ? input
          .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
  const length = Array.from(cleaned).length;
  return length >= ACCESS_RULES.roleNameMinLength &&
    length <= ACCESS_RULES.roleNameMaxLength
    ? ok(cleaned)
    : err(
        fail(
          IDENTITY_ERRORS.ROLE_NAME_INVALID,
          'A role name is 2 to 40 characters long.',
        ),
      );
};

/** How a role name is compared, so "Cashier" and " cashier " are one name. */
export const roleNameKey = (name: string): string => name.trim().toLowerCase();

/**
 * Checks a list of permissions for a role. Every entry must be in the
 * registry. The result has no repeats and is in the registry's order, so
 * the same set is always stored the same way.
 */
export const parseRolePermissions = (input: unknown): Result<Permission[]> => {
  if (!Array.isArray(input)) {
    return err(
      fail(
        IDENTITY_ERRORS.ROLE_PERMISSION_UNKNOWN,
        'Permissions must be a list.',
      ),
    );
  }
  const unknown = input.filter((item) => !isPermission(item));
  if (unknown.length > 0) {
    return err(
      fail(
        IDENTITY_ERRORS.ROLE_PERMISSION_UNKNOWN,
        'The list has a permission that does not exist.',
        { unknown: unknown.length },
      ),
    );
  }
  const wanted = new Set<unknown>(input);
  return ok(ALL_PERMISSIONS.filter((permission) => wanted.has(permission)));
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Checks the branches a membership is limited to. Null (or nothing) means
 * every branch. A list must name at least one branch: "no branch at all" is
 * not a limit, it is a suspension, and is done by suspending.
 */
export const parseBranchScope = (input: unknown): Result<string[] | null> => {
  if (input === null || input === undefined) return ok(null);
  const invalid = err(
    fail(
      IDENTITY_ERRORS.BRANCH_SCOPE_INVALID,
      'Choose every branch, or at least one branch.',
    ),
  );
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > ACCESS_RULES.maxBranchesPerMember ||
    !input.every((item) => typeof item === 'string' && UUID.test(item))
  ) {
    return invalid;
  }
  return ok([...new Set(input as string[])].sort());
};

/** Whether a membership may work in a branch. */
export const canEnterBranch = (
  membership: Pick<Membership, 'branchIds'>,
  branchId: string,
): boolean =>
  membership.branchIds === null || membership.branchIds.includes(branchId);

/**
 * The permissions in `wanted` that `held` does not include. Used for the
 * rule that nobody can grant what they do not hold: without it, anyone
 * allowed to edit roles could give themselves everything.
 */
export const permissionsBeyond = (
  held: readonly string[],
  wanted: readonly string[],
): string[] => {
  const own = new Set(held);
  return wanted.filter((permission) => !own.has(permission));
};

export const MEMBER_CHANGES = [
  'role',
  'branches',
  'suspend',
  'reinstate',
  'remove',
] as const;

export type MemberChange = (typeof MEMBER_CHANGES)[number];

export type MemberChangeVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'owner_protected' | 'self' | 'not_a_member' | 'no_change';
    };

/**
 * Decides whether a change to a membership may be made at all, before any
 * question of permissions.
 *
 * - The owner's membership is never changed this way: not their role, not
 *   their branches, and they cannot be suspended or removed.
 * - Nobody changes their own membership. A manager cannot promote, suspend
 *   or remove themselves, which keeps a mistake or a stolen session from
 *   locking the business out or widening its own access.
 * - A removed member is not edited; they are added again.
 */
export const judgeMemberChange = (input: {
  actorUserId: string;
  target: Pick<Membership, 'userId' | 'status'>;
  targetRole: Pick<Role, 'key'>;
  change: MemberChange;
}): MemberChangeVerdict => {
  const { actorUserId, target, targetRole, change } = input;
  if (target.status === 'removed') {
    return { allowed: false, reason: 'not_a_member' };
  }
  if (isOwnerRole(targetRole)) {
    return { allowed: false, reason: 'owner_protected' };
  }
  if (target.userId === actorUserId) {
    return { allowed: false, reason: 'self' };
  }
  if (
    (change === 'suspend' && target.status === 'suspended') ||
    (change === 'reinstate' && target.status === 'active')
  ) {
    return { allowed: false, reason: 'no_change' };
  }
  return { allowed: true };
};

/** What a person may do in one business, worked out for one request. */
export interface Access {
  userId: string;
  tenantId: string;
  businessId: string;
  membershipId: string;
  roleId: string;
  /** The built-in role, or null for a custom one. */
  roleKey: SystemRoleKey | null;
  isOwner: boolean;
  /** The branches the person may work in, or null for every branch. */
  branchIds: readonly string[] | null;
  /** The branch this request is for, or null when it names none. */
  branchId: string | null;
  permissions: readonly Permission[];
}

/**
 * The permissions a member actually holds: what their role grants, minus
 * anything that is not a real permission, minus anything belonging to a
 * product the business does not have. So not even the owner holds a payroll
 * permission in a business without payroll.
 */
export const permissionsHeld = (
  role: Pick<Role, 'key' | 'permissions'>,
  enabledProducts: readonly ProductKey[],
): Permission[] => effectivePermissions(grantedBy(role), enabledProducts);

/** The built-in role keys, re-exported so storage adapters need not reach into contracts. */
export {
  SYSTEM_ROLE_KEYS,
  type SystemRoleKey,
} from '@hk/contracts/permissions';
