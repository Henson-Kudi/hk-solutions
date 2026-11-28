import { ALL_PERMISSIONS } from '@hk/contracts/permissions';
import type { Result } from '@hk/platform/universal';
import {
  ACCESS_RULES,
  canEnterBranch,
  grantedBy,
  isOwnerRole,
  judgeMemberChange,
  parseBranchScope,
  parseRoleName,
  parseRolePermissions,
  permissionsBeyond,
  permissionsHeld,
  roleNameKey,
  type MemberChange,
  type MemberStatus,
} from './access';
import { IDENTITY_ERRORS } from './errors';

const codeOf = (result: Result<unknown>) =>
  result.ok ? 'ok' : result.error.code;
const valueOf = <T>(result: Result<T>) =>
  result.ok ? result.value : `error: ${result.error.code}`;

const BRANCH_A = '018f0000-0000-7000-8000-00000000b001';
const BRANCH_B = '018f0000-0000-7000-8000-00000000b002';

describe('access rules', () => {
  it('are the agreed values', () => {
    expect(ACCESS_RULES).toEqual({
      roleNameMinLength: 2,
      roleNameMaxLength: 40,
      maxRolesPerBusiness: 50,
      maxBranchesPerMember: 200,
    });
  });
});

describe('what a role grants', () => {
  it('gives the owner everything, whatever is stored', () => {
    expect(isOwnerRole({ key: 'owner' })).toBe(true);
    expect(grantedBy({ key: 'owner', permissions: [] })).toEqual([
      ...ALL_PERMISSIONS,
    ]);
    expect(grantedBy({ key: 'owner', permissions: ['stock:view'] })).toEqual([
      ...ALL_PERMISSIONS,
    ]);
  });

  it('gives every other role exactly what is stored', () => {
    expect(isOwnerRole({ key: 'manager' })).toBe(false);
    expect(isOwnerRole({ key: null })).toBe(false);
    expect(
      grantedBy({ key: 'cashier', permissions: ['invoices:view'] }),
    ).toEqual(['invoices:view']);
    expect(grantedBy({ key: null, permissions: [] })).toEqual([]);
  });

  it('holds only real permissions of products the business has', () => {
    const role = {
      key: null,
      permissions: [
        'accounts:view',
        'invoices:issue',
        'payroll_runs:pay',
        'invoices:delete', // not in the registry
      ],
    };
    expect(permissionsHeld(role, ['sales'])).toEqual([
      'accounts:view',
      'invoices:issue',
    ]);
    expect(permissionsHeld(role, [])).toEqual(['accounts:view']);
  });

  it('does not give even the owner a product the business lacks', () => {
    const held = permissionsHeld({ key: 'owner', permissions: [] }, ['sales']);
    expect(held).toContain('invoices:void');
    expect(held).toContain('members:remove');
    expect(held.some((item) => item.startsWith('payroll_runs:'))).toBe(false);
  });
});

describe('parseRoleName', () => {
  it.each<[unknown, string]>([
    ['Shift lead', 'Shift lead'],
    ['  Chef   de\trayon ', 'Chef de rayon'],
    ['QA', 'QA'],
    ['مدير الفرع', 'مدير الفرع'],
    ['Lead‮\u0000X', 'Lead X'],
    ['a'.repeat(40), 'a'.repeat(40)],
  ])('%j becomes %j', (input, expected) => {
    expect(valueOf(parseRoleName(input))).toBe(expected);
  });

  it.each<[unknown]>([
    [''],
    ['A'],
    ['   '],
    ['a'.repeat(41)],
    [null],
    [undefined],
    [12],
    [['Manager']],
  ])('refuses %j', (input) => {
    expect(codeOf(parseRoleName(input))).toBe(
      IDENTITY_ERRORS.ROLE_NAME_INVALID,
    );
  });

  it('compares names without case or outer spaces', () => {
    expect(roleNameKey(' Cashier ')).toBe(roleNameKey('cashier'));
    expect(roleNameKey('Cashier')).not.toBe(roleNameKey('Cashiers'));
  });
});

describe('parseRolePermissions', () => {
  it('keeps real permissions, once each, in the registry’s order', () => {
    expect(
      valueOf(
        parseRolePermissions([
          'stock:view',
          'accounts:view',
          'stock:view',
          'invoices:issue',
        ]),
      ),
    ).toEqual(['accounts:view', 'invoices:issue', 'stock:view']);
  });

  it('accepts an empty list: a role that grants nothing yet', () => {
    expect(valueOf(parseRolePermissions([]))).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['a permission that does not exist', ['accounts:view', 'accounts:delete']],
    ['a wildcard', ['*']],
    ['a resource with no action', ['accounts']],
    ['something that is not text', ['accounts:view', 7]],
    ['not a list', 'accounts:view'],
    ['nothing', undefined],
    ['an object', { 'accounts:view': true }],
  ])('refuses %s', (_name, input) => {
    expect(codeOf(parseRolePermissions(input))).toBe(
      IDENTITY_ERRORS.ROLE_PERMISSION_UNKNOWN,
    );
  });

  it('says how many are unknown, without repeating them', () => {
    const result = parseRolePermissions(['x:y', 'accounts:view', 'z']);
    expect(!result.ok && result.error.details).toEqual({ unknown: 2 });
  });
});

describe('branches', () => {
  it.each<[unknown]>([[null], [undefined]])(
    'reads %j as every branch',
    (input) => {
      expect(valueOf(parseBranchScope(input))).toBeNull();
    },
  );

  it('keeps a list of branches, once each and in a fixed order', () => {
    expect(valueOf(parseBranchScope([BRANCH_B, BRANCH_A, BRANCH_B]))).toEqual([
      BRANCH_A,
      BRANCH_B,
    ]);
  });

  it.each<[string, unknown]>([
    // "No branch" is a suspension, not a limit.
    ['an empty list', []],
    ['something that is not an id', ['main']],
    ['an id in upper case', [BRANCH_A.toUpperCase()]],
    ['a mix of ids and other things', [BRANCH_A, 5]],
    ['a single id, not in a list', BRANCH_A],
    ['more branches than allowed', new Array(201).fill(BRANCH_A)],
  ])('refuses %s', (_name, input) => {
    expect(codeOf(parseBranchScope(input))).toBe(
      IDENTITY_ERRORS.BRANCH_SCOPE_INVALID,
    );
  });

  it('lets a member with every branch in anywhere', () => {
    expect(canEnterBranch({ branchIds: null }, BRANCH_A)).toBe(true);
  });

  it('lets a limited member into their branches only', () => {
    expect(canEnterBranch({ branchIds: [BRANCH_A] }, BRANCH_A)).toBe(true);
    expect(canEnterBranch({ branchIds: [BRANCH_A] }, BRANCH_B)).toBe(false);
  });
});

describe('permissionsBeyond', () => {
  it('lists what is wanted and not held', () => {
    expect(
      permissionsBeyond(
        ['invoices:view', 'stock:view'],
        ['invoices:view', 'invoices:void', 'stock:adjust'],
      ),
    ).toEqual(['invoices:void', 'stock:adjust']);
  });

  it('is empty when everything wanted is held, or nothing is wanted', () => {
    expect(permissionsBeyond(['a', 'b'], ['b'])).toEqual([]);
    expect(permissionsBeyond([], [])).toEqual([]);
  });
});

describe('judgeMemberChange', () => {
  const judge = (
    change: MemberChange,
    overrides: {
      target?: string;
      status?: MemberStatus;
      role?: 'owner' | 'manager' | null;
    } = {},
  ) =>
    judgeMemberChange({
      actorUserId: 'actor',
      target: {
        userId: overrides.target ?? 'someone',
        status: overrides.status ?? 'active',
      },
      targetRole: {
        key: overrides.role === undefined ? 'manager' : overrides.role,
      },
      change,
    });

  it.each<MemberChange>(['role', 'branches', 'suspend', 'remove'])(
    'allows "%s" on another active member',
    (change) => {
      expect(judge(change)).toEqual({ allowed: true });
    },
  );

  it.each<MemberChange>(['role', 'branches', 'suspend', 'reinstate', 'remove'])(
    'never allows "%s" on the owner',
    (change) => {
      expect(judge(change, { role: 'owner', status: 'active' })).toEqual({
        allowed: false,
        reason: 'owner_protected',
      });
    },
  );

  it('protects the owner even from themselves', () => {
    expect(judge('remove', { role: 'owner', target: 'actor' })).toEqual({
      allowed: false,
      reason: 'owner_protected',
    });
  });

  it.each<MemberChange>(['role', 'branches', 'suspend', 'remove'])(
    'never allows a member to "%s" themselves',
    (change) => {
      expect(judge(change, { target: 'actor' })).toEqual({
        allowed: false,
        reason: 'self',
      });
    },
  );

  it('reinstates a suspended member, and allows changes to one', () => {
    expect(judge('reinstate', { status: 'suspended' })).toEqual({
      allowed: true,
    });
    expect(judge('role', { status: 'suspended' })).toEqual({ allowed: true });
    expect(judge('remove', { status: 'suspended' })).toEqual({ allowed: true });
  });

  it('reports no change when there is nothing to do', () => {
    expect(judge('suspend', { status: 'suspended' })).toEqual({
      allowed: false,
      reason: 'no_change',
    });
    expect(judge('reinstate', { status: 'active' })).toEqual({
      allowed: false,
      reason: 'no_change',
    });
  });

  it.each<MemberChange>(['role', 'branches', 'suspend', 'reinstate', 'remove'])(
    'treats a removed member as not a member for "%s"',
    (change) => {
      expect(judge(change, { status: 'removed' })).toEqual({
        allowed: false,
        reason: 'not_a_member',
      });
    },
  );

  it('applies to a member with a custom role as to any other', () => {
    expect(judge('remove', { role: null })).toEqual({ allowed: true });
  });
});
